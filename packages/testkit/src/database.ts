import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function createTestDatabaseUrl(name: string) {
  const safeName = name.replaceAll(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return `postgresql://postgres:postgres@localhost:5432/${safeName}`;
}

export const defaultTestDatabaseUrl = createTestDatabaseUrl("lumenbazaar_test");

/**
 * Creates a disposable test database with a unique name based on timestamp and random ID.
 * Returns the database URL and a cleanup function to drop the database.
 *
 * @param baseUrl - The PostgreSQL connection URL (e.g., to the postgres maintenance database)
 * @returns Object with `databaseUrl` and `cleanup` function
 */
export async function createDisposableTestDatabase(
  baseUrl: string = "postgresql://postgres:postgres@localhost:5432/postgres"
) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const dbName = `test_${timestamp}_${random}`;

  // Extract connection parameters from base URL
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = url.port || "5432";
  const user = url.username || "postgres";
  const password = url.password || "postgres";

  // Create the database
  const createDbUrl = `postgresql://${user}${password ? `:${password}` : ""}@${host}:${port}/postgres`;
  const createDbCommand = `psql "${createDbUrl}" -c "CREATE DATABASE ${dbName};"`;

  try {
    await execAsync(createDbCommand);
  } catch (error) {
    throw new Error(`Failed to create test database ${dbName}: ${error}`);
  }

  const databaseUrl = `postgresql://${user}${password ? `:${password}` : ""}@${host}:${port}/${dbName}`;

  /**
   * Cleanup function to drop the disposable database
   */
  async function cleanup() {
    try {
      // Terminate all connections to the database before dropping it
      const terminateCommand = `psql "${createDbUrl}" -c "SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '${dbName}' AND pid <> pg_backend_pid();"`;
      await execAsync(terminateCommand);

      // Drop the database
      const dropDbCommand = `psql "${createDbUrl}" -c "DROP DATABASE IF EXISTS ${dbName};"`;
      await execAsync(dropDbCommand);
    } catch (error) {
      console.error(`Failed to cleanup test database ${dbName}: ${error}`);
    }
  }

  return { databaseUrl, cleanup, dbName };
}

/**
 * Runs Prisma migrations on a given database URL.
 * Assumes Prisma is installed and schema.prisma exists.
 *
 * @param databaseUrl - The database URL to migrate
 * @param schemaPath - Path to prisma/schema.prisma (defaults to "prisma/schema.prisma")
 */
export async function runMigrations(
  databaseUrl: string,
  schemaPath: string = "prisma/schema.prisma"
) {
  const command = `DATABASE_URL="${databaseUrl}" pnpm exec prisma migrate deploy --schema "${schemaPath}"`;

  try {
    const { stdout, stderr } = await execAsync(command);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(`Migration failed: ${error}`);
  }
}

/**
 * Verifies that all migrations apply cleanly from an empty database.
 * Creates a disposable database, runs migrations, and cleans up.
 *
 * @param maintenanceDbUrl - The PostgreSQL maintenance database URL (defaults to postgres db)
 * @param schemaPath - Path to prisma/schema.prisma
 */
export async function verifyMigrationsApplyFromEmpty(
  maintenanceDbUrl?: string,
  schemaPath?: string
) {
  const { databaseUrl, cleanup, dbName } = await createDisposableTestDatabase(maintenanceDbUrl);

  try {
    await runMigrations(databaseUrl, schemaPath);
    return { success: true, dbName, databaseUrl };
  } finally {
    await cleanup();
  }
}

/**
 * Rolls back migrations by recreating the schema from an earlier migration.
 * Useful for testing upgrade paths.
 *
 * @param databaseUrl - The database URL to rollback
 * @param targetMigrationName - The migration to rollback to (e.g., "0001_core_catalog")
 * @param schemaPath - Path to prisma/schema.prisma
 */
export async function rollbackToMigration(
  databaseUrl: string,
  targetMigrationName: string,
  schemaPath: string = "prisma/schema.prisma"
) {
  const command = `DATABASE_URL="${databaseUrl}" pnpm exec prisma migrate resolve --applied "${targetMigrationName}" --schema "${schemaPath}"`;

  try {
    const { stdout, stderr } = await execAsync(command);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(`Rollback to ${targetMigrationName} failed: ${error}`);
  }
}

/**
 * Validates database constraints by attempting to insert fixture data
 * and verifying constraint violations are caught.
 *
 * @param prismaClient - An instance of PrismaClient connected to the test database
 * @param tableName - The table name to verify constraints on
 * @param fixtureData - Object containing field values to test
 * @param constraintType - Type of constraint to verify ("unique" | "foreignKey" | "notNull")
 */
export async function verifyDatabaseConstraint(
  prismaClient: any,
  tableName: string,
  fixtureData: Record<string, any>,
  constraintType: "unique" | "foreignKey" | "notNull"
): Promise<boolean> {
  try {
    const table = prismaClient[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in Prisma client`);
    }

    switch (constraintType) {
      case "unique": {
        // First insert should succeed
        const firstInsert = await table.create({ data: fixtureData });

        // Second insert with same unique field should fail
        try {
          await table.create({ data: fixtureData });
          return false; // Constraint not enforced
        } catch {
          // Expected: constraint violation
          await table.delete({ where: { id: firstInsert.id } });
          return true;
        }
      }

      case "foreignKey": {
        // Attempt to insert with non-existent foreign key
        try {
          await table.create({ data: fixtureData });
          return false; // Constraint not enforced
        } catch {
          // Expected: foreign key constraint violation
          return true;
        }
      }

      case "notNull": {
        // Attempt to insert without required field
        try {
          await table.create({ data: fixtureData });
          return false; // Constraint not enforced
        } catch {
          // Expected: not null constraint violation
          return true;
        }
      }

      default:
        throw new Error(`Unknown constraint type: ${constraintType}`);
    }
  } catch (error) {
    throw new Error(`Constraint verification failed: ${error}`);
  }
}
