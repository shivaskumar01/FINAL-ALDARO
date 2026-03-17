import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuthor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireReauth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCustomerApproved: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
