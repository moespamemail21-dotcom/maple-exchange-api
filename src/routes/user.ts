import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users, kycDocuments } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { storeFile, validateUpload } from '../services/storage.js';
import { getUserById } from '../services/auth.js';

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  interacEmail: z.string().trim().email().optional(),
  locale: z.enum(['en', 'fr']).optional(),
  phone: z.string().trim().min(10).max(20).optional(),
});

const kycSubmitSchema = z.object({
  // Accept either fullLegalName OR firstName+lastName (iOS sends the latter)
  fullLegalName: z.string().trim().min(2).max(255).optional(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.string().trim().min(5).max(500),
  city: z.string().trim().min(1).max(100).optional(),
  province: z.string().length(2).optional(),
  postalCode: z.string().trim().min(3).max(10).optional(),
  occupation: z.string().trim().max(100).optional(),
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

    // If interacEmail is changing, reset autodepositVerified to force re-verification.
    // This prevents a compromised session from redirecting sell proceeds silently.
    const updateData: Record<string, any> = { ...body, updatedAt: new Date() };
    if (body.interacEmail) {
      const [currentUser] = await db
        .select({ interacEmail: users.interacEmail })
        .from(users)
        .where(eq(users.id, request.userId));
      if (currentUser && currentUser.interacEmail !== body.interacEmail) {
        updateData.autodepositVerified = false;
      }
    }

    await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, request.userId));

    // Return full user object so iOS can decode as User struct
    const user = await getUserById(request.userId);
    return user;
  };

  app.patch('/api/user/profile', { preHandler: [authGuard] }, updateProfileHandler);
  app.post('/api/user/profile', { preHandler: [authGuard] }, updateProfileHandler);

  // ─── Submit KYC Data (CARF compliance) ────────────────────────────────
  app.post('/api/user/kyc', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = kycSubmitSchema.parse(request.body);

    // Merge firstName+lastName into fullLegalName (iOS sends these separately)
    const fullLegalName = body.fullLegalName ?? `${body.firstName} ${body.lastName}`;

    // Atomic: check status + update inside transaction with row lock
    const result = await db.transaction(async (tx) => {
      const lockResult = await tx.execute(
        sql`SELECT kyc_status FROM users WHERE id = ${request.userId} FOR UPDATE`,
      ) as any;
      const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
      const kycStatus = rows[0]?.kyc_status;

      if (kycStatus === 'verified') {
        return { error: 'KYC already verified. Contact support to update.', code: 409 } as const;
      }
      if (kycStatus === 'pending') {
        return { error: 'KYC already submitted and under review.', code: 409 } as const;
      }

      await tx
        .update(users)
        .set({
          fullLegalName,
          dateOfBirth: body.dateOfBirth,
          address: body.address,
          city: body.city ?? null,
          province: body.province ?? null,
          postalCode: body.postalCode ?? null,
          occupation: body.occupation ?? null,
          sin: body.sin ? body.sin.replace(/-/g, '') : null,
          kycStatus: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(users.id, request.userId));

      return { success: true } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    return { status: 'pending', message: 'KYC submitted. Under review.' };
  });

  // ─── Upload KYC Document (video/photo) ──────────────────────────────
  app.post('/api/user/kyc/document', { preHandler: [authGuard] }, async (request, reply) => {
    // Before processing upload, check document count
    const existingDocs = await db.select({ id: kycDocuments.id })
      .from(kycDocuments)
      .where(eq(kycDocuments.userId, request.userId));
    if (existingDocs.length >= 10) {
      return reply.status(429).send({ error: 'Maximum document upload limit reached (10). Contact support.' });
    }

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
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 20, 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

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
      .orderBy(desc(kycDocuments.uploadedAt))
      .limit(limit)
      .offset(offset);

    return { documents: docs };
  });

  // ─── Verify Autodeposit (Self-attestation for MVP) ────────────────────
  const verifyAutodepositSchema = z.object({
    interacEmail: z.string().email().optional(),
  }).optional();

  app.post('/api/user/verify-autodeposit', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    // Must be KYC verified before enabling autodeposit (required for selling)
    const [currentUser] = await db.select().from(users).where(eq(users.id, request.userId));
    if (!currentUser || currentUser.kycStatus !== 'verified') {
      return reply.status(403).send({ error: 'Complete identity verification (KYC) before enabling autodeposit.' });
    }

    const body = verifyAutodepositSchema.parse(request.body);
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
