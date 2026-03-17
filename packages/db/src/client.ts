import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma Client
 * 
 * IMPORTANT: Only import prisma from this module to avoid connection pool exhaustion.
 * Multiple PrismaClient instances create separate connection pools.
 * 
 * Usage:
 *   import { prisma } from '@aldaro/db';
 */

declare global {
  // Allow global `var` declarations
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Prevent multiple instances in development (hot reload)
export const prisma = global.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'info', 'warn', 'error']
    : ['warn', 'error'],
});

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
