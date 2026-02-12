import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users, kycDocuments } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { storeFile, validateUpload } from '../services/storage.js';
import { getUserById } from '../services/auth.js';

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  interacEmail: z.string().email().optional(),
  locale: z.enum(['en', 'fr']).optional(),
  phone: z.string().min(10).max(20).optional(),
});

const kycSubmitSchema = z.object({
  // Accept either fullLegalName OR firstName+lastName (iOS sends the latter)
  fullLegalName: z.string().min(2).max(255).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.string().min(5).max(500),
  city: z.string().min(1).max(100).optional(),
  province: z.string().length(2).optional(),
  postalCode: z.string().min(3).max(10).optional(),
  occupation: z.string().max(100).optional(),
  sin: z.string().regex(/^\d{3}-?\d{3}-?\d{3}$/).optional(),
}).refine(
  (data) => data.fullLegalName || (data.firstName && data.lastName),
  { message: 'Provide fullLegalName, or both firstName and lastName' },
);

const VALID_DOCUMENT_TYPES = ['selfie_video', 'id_front', 'id_back', 'proof_of_address', 'holding_id_video'] as const;

export async function userRoutes(app: FastifyInstance) {
  // ─── Update Profile (accept both PATCH and POST from iOS) ────────────
  const updateProfileHandler = async (request: any) => {
    const body = updateProfileSchema.parse(request.body);

    await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, request.userId));

    // Return full user object so iOS can decode as User struct
    const user = await getUserById(request.userId);
    return user;
  };

  app.patch('/api/user/profile', { preHandler: [authGuard] }, updateProfileHandler);
  app.post('/api/user/profile', { preHandler: [authGuard] }, updateProfileHandler);

  // ─── Submit KYC Data (CARF compliance) ────────────────────────────────
  app.post('/api/user/kyc', { preHandler: [authGuard] }, async (request, reply) => {
    const body = kycSubmitSchema.parse(request.body);

    // Merge firstName+lastName into fullLegalName (iOS sends these separately)
    const fullLegalName = body.fullLegalName ?? `${body.firstName} ${body.lastName}`;

    await db
      .update(users)
      .set({
        fullLegalName,
        dateOfBirth: body.dateOfBirth,
        address: body.address,
        city: body.city ?? null,
        province: body.province ?? null,
        postalCode: body.postalCode ?? null,
        occupation: body.occupation ?? null,
        sin: body.sin ?? null,
        // Auto-verify for MVP — real verification would involve document review
        kycStatus: 'verified',
        updatedAt: new Date(),
      })
      .where(eq(users.id, request.userId));

    return { status: 'verified', message: 'KYC verified successfully.' };
  });

  // ─── Upload KYC Document (video/photo) ──────────────────────────────
  app.post('/api/user/kyc/document', { preHandler: [authGuard] }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded. Use multipart/form-data.' });
    }

    // Extract document type from form field
    const documentType = (data.fields?.documentType as any)?.value as string | undefined;
    if (!documentType || !VALID_DOCUMENT_TYPES.includes(documentType as any)) {
      return reply.status(400).send({
        error: `Invalid documentType. Must be one of: ${VALID_DOCUMENT_TYPES.join(', ')}`,
      });
    }

    // Read file buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Validate MIME type and size
    const validationError = validateUpload(data.mimetype, buffer.length);
    if (validationError) {
      return reply.status(400).send({ error: validationError });
    }

    // Store the file
    const stored = await storeFile(request.userId, documentType, data.mimetype, buffer);

    // Record in database
    const [doc] = await db
      .insert(kycDocuments)
      .values({
        userId: request.userId,
        documentType,
        mimeType: data.mimetype,
        fileSize: stored.fileSize,
        storagePath: stored.storagePath,
        storageBackend: stored.storageBackend,
        sha256Hash: stored.sha256Hash,
      })
      .returning();

    // If this is a video, update user's kycVideoStatus
    if (documentType === 'selfie_video' || documentType === 'holding_id_video') {
      await db
        .update(users)
        .set({ kycVideoStatus: 'submitted', updatedAt: new Date() })
        .where(eq(users.id, request.userId));
    }

    return reply.status(201).send({
      document: {
        id: doc.id,
        documentType: doc.documentType,
        fileSize: doc.fileSize,
        reviewStatus: doc.reviewStatus,
        uploadedAt: doc.uploadedAt,
      },
      message: 'Document uploaded successfully. Under review.',
    });
  });

  // ─── List KYC Documents ─────────────────────────────────────────────
  app.get('/api/user/kyc/documents', { preHandler: [authGuard] }, async (request) => {
    const docs = await db
      .select({
        id: kycDocuments.id,
        documentType: kycDocuments.documentType,
        mimeType: kycDocuments.mimeType,
        fileSize: kycDocuments.fileSize,
        reviewStatus: kycDocuments.reviewStatus,
        reviewNote: kycDocuments.reviewNote,
        uploadedAt: kycDocuments.uploadedAt,
        reviewedAt: kycDocuments.reviewedAt,
      })
      .from(kycDocuments)
      .where(eq(kycDocuments.userId, request.userId))
      .orderBy(desc(kycDocuments.uploadedAt));

    return { documents: docs };
  });

  // ─── Verify Autodeposit (Self-attestation for MVP) ────────────────────
  app.post('/api/user/verify-autodeposit', { preHandler: [authGuard] }, async (request, reply) => {
    // iOS sends { interacEmail } — store it and verify in one call
    const body = request.body as { interacEmail?: string } | undefined;
    const emailFromBody = body?.interacEmail;

    if (emailFromBody) {
      // Store the email and verify in one step
      await db
        .update(users)
        .set({
          interacEmail: emailFromBody,
          autodepositVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, request.userId));
    } else {
      // No email in body — check if user already has one stored
      const [user] = await db.select().from(users).where(eq(users.id, request.userId));
      if (!user?.interacEmail) {
        return reply.status(400).send({ error: 'Provide interacEmail in request body, or set it via /api/user/profile first' });
      }

      await db
        .update(users)
        .set({ autodepositVerified: true, updatedAt: new Date() })
        .where(eq(users.id, request.userId));
    }

    return { success: true, message: 'Autodeposit verified. You can now create sell orders.' };
  });

}
