import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { supportTickets, ticketMessages } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';

// ─── Validation Schemas ─────────────────────────────────────────────────────

const CATEGORIES = ['account', 'trading', 'deposit', 'withdrawal', 'security', 'other'] as const;

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(255),
  category: z.enum(CATEGORIES),
  message: z.string().trim().min(10).max(5000),
});

const addMessageSchema = z.object({
  content: z.string().trim().min(1).max(5000),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function supportRoutes(app: FastifyInstance) {

  // Create a new support ticket
  app.post('/api/support/tickets', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = createTicketSchema.parse(request.body);

    const [ticket] = await db.insert(supportTickets).values({
      userId: request.userId,
      subject: body.subject,
      category: body.category,
    }).returning();

    // Insert the initial message
    const [message] = await db.insert(ticketMessages).values({
      ticketId: ticket.id,
      senderId: request.userId,
      content: body.message,
      isStaff: false,
    }).returning();

    return reply.status(201).send({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        category: ticket.category,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        resolvedAt: null,
        messages: [{
          id: message.id,
          content: message.content,
          isStaff: message.isStaff,
          createdAt: message.createdAt.toISOString(),
        }],
      },
    });
  });

  // List user's tickets with pagination
  app.get('/api/support/tickets', { preHandler: [authGuard] }, async (request) => {
    const { limit, offset } = paginationSchema.parse(request.query);

    const tickets = await db
      .select({
        id: supportTickets.id,
        subject: supportTickets.subject,
        category: supportTickets.category,
        status: supportTickets.status,
        priority: supportTickets.priority,
        createdAt: supportTickets.createdAt,
        updatedAt: supportTickets.updatedAt,
        resolvedAt: supportTickets.resolvedAt,
      })
      .from(supportTickets)
      .where(eq(supportTickets.userId, request.userId))
      .orderBy(desc(supportTickets.updatedAt))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(eq(supportTickets.userId, request.userId));

    return {
      tickets: tickets.map(t => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        resolvedAt: t.resolvedAt?.toISOString() ?? null,
      })),
      total: count,
      limit,
      offset,
    };
  });

  // Get ticket detail with all messages
  app.get('/api/support/tickets/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(and(
        eq(supportTickets.id, id),
        eq(supportTickets.userId, request.userId),
      ));

    if (!ticket) {
      return reply.status(404).send({ error: 'Ticket not found' });
    }

    const messages = await db
      .select({
        id: ticketMessages.id,
        content: ticketMessages.content,
        isStaff: ticketMessages.isStaff,
        senderId: ticketMessages.senderId,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticket.id))
      .orderBy(ticketMessages.createdAt);

    return {
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        category: ticket.category,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
      },
      messages: messages.map(m => ({
        id: m.id,
        content: m.content,
        isStaff: m.isStaff,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  // Add a message to an existing ticket
  app.post('/api/support/tickets/:id/messages', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const body = addMessageSchema.parse(request.body);

    // Verify ticket belongs to user and is not closed
    const [ticket] = await db
      .select({ id: supportTickets.id, status: supportTickets.status })
      .from(supportTickets)
      .where(and(
        eq(supportTickets.id, id),
        eq(supportTickets.userId, request.userId),
      ));

    if (!ticket) {
      return reply.status(404).send({ error: 'Ticket not found' });
    }

    if (ticket.status === 'closed') {
      return reply.status(400).send({ error: 'Cannot add messages to a closed ticket' });
    }

    const [message] = await db.insert(ticketMessages).values({
      ticketId: ticket.id,
      senderId: request.userId,
      content: body.content,
      isStaff: false,
    }).returning();

    // Update ticket's updatedAt timestamp
    await db
      .update(supportTickets)
      .set({ updatedAt: new Date() })
      .where(eq(supportTickets.id, ticket.id));

    return reply.status(201).send({
      message: {
        id: message.id,
        content: message.content,
        isStaff: message.isStaff,
        createdAt: message.createdAt.toISOString(),
      },
    });
  });

  // Close a ticket
  app.post('/api/support/tickets/:id/close', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [ticket] = await db
      .select({ id: supportTickets.id, status: supportTickets.status })
      .from(supportTickets)
      .where(and(
        eq(supportTickets.id, id),
        eq(supportTickets.userId, request.userId),
      ));

    if (!ticket) {
      return reply.status(404).send({ error: 'Ticket not found' });
    }

    if (ticket.status === 'closed') {
      return reply.status(400).send({ error: 'Ticket is already closed' });
    }

    const now = new Date();
    const [updated] = await db
      .update(supportTickets)
      .set({
        status: 'closed',
        updatedAt: now,
        resolvedAt: now,
      })
      .where(eq(supportTickets.id, ticket.id))
      .returning();

    return {
      ticket: {
        id: updated.id,
        status: updated.status,
        updatedAt: updated.updatedAt.toISOString(),
        resolvedAt: updated.resolvedAt?.toISOString() ?? null,
      },
    };
  });
}
