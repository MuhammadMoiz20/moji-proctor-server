import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;
let prismaInitError: Error | null = null;

function getPrismaInstance(): PrismaClient {
  if (prismaInitError) {
    throw prismaInitError;
  }
  if (!prismaInstance) {
    try {
      prismaInstance = new PrismaClient();
    } catch (error) {
      prismaInitError = error instanceof Error ? error : new Error(String(error));
      throw prismaInitError;
    }
  }
  return prismaInstance;
}

export async function disconnectPrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const instance = getPrismaInstance();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
