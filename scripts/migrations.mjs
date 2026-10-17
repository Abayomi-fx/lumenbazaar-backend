#!/usr/bin/env node

/**
 * Migration testing script for disposable test databases.
 *
 * This script manages disposable PostgreSQL databases for testing
 * migrations, constraints, and upgrade paths.
 *
 * Usage:
 *   node scripts/migrations.mjs create [name]        - Create a disposable test database
 *   node scripts/migrations.mjs migrate [db-url]     - Run migrations on a database
 *   node scripts/migrations.mjs verify               - Create, migrate, and verify from empty
 *   node scripts/migrations.mjs cleanup              - Remove all test_* databases
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execAsync = promisify(exec);

const SCHEMA_PATH = "prisma/schema.prisma";
const MAINTENANCE_DB_URL =
  process.env.MAINTENANCE_DB_URL ||
  "postgresql://postgres:postgres@localhost:5432/postgres";

/**
 * Parse PostgreSQL connection URL components
 */
function parsePostgresUrl(url) {
  const urlObj = new URL(url);
  return {
    host: urlObj.hostname,
    port: urlObj.port || "5432",
    user: urlObj.username || "postgres",
    password: urlObj.password || "postgres",
    database: urlObj.pathname.substring(1)
  };
}

/**
 * Build psql command string
 */
function buildPsqlCommand(url, query) {
  const params = parsePostgresUrl(url);
  const pgpassFile = [
    `${params.host}:${params.port}:*:${params.user}:${params.password}`
  ].join(":");

  // Use PGPASSWORD environment variable to avoid password prompt
  return `PGPASSWORD="${params.password}" psql -h ${params.host} -p ${params.port} -U ${params.user} -d ${params.database} -c "${query}"`;
}

/**
 * Create a disposable test database
 */
async function createTestDatabase(name = null) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const dbName = name || `test_${timestamp}_${random}`;

  console.log(`Creating disposable test database: ${dbName}`);

  const createCommand = buildPsqlCommand(
    MAINTENANCE_DB_URL,
    `CREATE DATABASE ${dbName};`
  );

  try {
    const { stdout, stderr } = await execAsync(createCommand);
    console.log(`✓ Database created: ${dbName}`);

    const params = parsePostgresUrl(MAINTENANCE_DB_URL);
    const dbUrl = `postgresql://${params.user}:${params.password}@${params.host}:${params.port}/${dbName}`;

    console.log(`Database URL: ${dbUrl}`);
    return dbUrl;
  } catch (error) {
    console.error(`✗ Failed to create database ${dbName}`);
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Run migrations on a database
 */
async function runMigrationsOnDatabase(databaseUrl) {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`✗ Schema not found: ${SCHEMA_PATH}`);
    process.exit(1);
  }

  console.log("Running migrations...");

  const command = `DATABASE_URL="${databaseUrl}" pnpm exec prisma migrate deploy --schema "${SCHEMA_PATH}"`;

  try {
    const { stdout, stderr } = await execAsync(command);
    console.log("✓ Migrations completed");
    if (stdout) console.log(stdout);
    return true;
  } catch (error) {
    console.error("✗ Migration failed");
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Verify migrations apply cleanly from empty database
 */
async function verifyMigrations() {
  console.log("Verifying migrations from empty database...\n");

  const dbUrl = await createTestDatabase();

  try {
    await runMigrationsOnDatabase(dbUrl);
    console.log("\n✓ Migrations verified successfully\n");

    // Clean up
    await cleanupDatabase(dbUrl);
    console.log("✓ Temporary database cleaned up");
  } catch (error) {
    console.error("\n✗ Migration verification failed");
    // Attempt cleanup
    await cleanupDatabase(dbUrl);
    process.exit(1);
  }
}

/**
 * Clean up a database
 */
async function cleanupDatabase(databaseUrl) {
  const params = parsePostgresUrl(databaseUrl);
  const maintenanceParams = parsePostgresUrl(MAINTENANCE_DB_URL);

  // Terminate all connections to the database
  const terminateCommand = buildPsqlCommand(
    MAINTENANCE_DB_URL,
    `SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '${params.database}' AND pid <> pg_backend_pid();`
  );

  try {
    await execAsync(terminateCommand);
  } catch (error) {
    // Ignore errors during termination
  }

  // Drop the database
  const dropCommand = buildPsqlCommand(
    MAINTENANCE_DB_URL,
    `DROP DATABASE IF EXISTS ${params.database};`
  );

  try {
    await execAsync(dropCommand);
    console.log(`✓ Cleaned up database: ${params.database}`);
  } catch (error) {
    console.error(`✗ Failed to cleanup database ${params.database}`);
    console.error(error.message);
  }
}

/**
 * Clean up all test databases
 */
async function cleanupAllTestDatabases() {
  console.log("Finding test databases...");

  const listCommand = buildPsqlCommand(
    MAINTENANCE_DB_URL,
    `SELECT datname FROM pg_database WHERE datname LIKE 'test_%' ORDER BY datname;`
  );

  try {
    const { stdout } = await execAsync(listCommand);
    const databases = stdout
      .split("\n")
      .filter((line) => line.match(/^ *test_/))
      .map((line) => line.trim());

    if (databases.length === 0) {
      console.log("No test databases found");
      return;
    }

    console.log(`Found ${databases.length} test database(s):`);
    databases.forEach((db) => console.log(`  - ${db}`));

    for (const dbName of databases) {
      const params = parsePostgresUrl(MAINTENANCE_DB_URL);
      const dbUrl = `postgresql://${params.user}:${params.password}@${params.host}:${params.port}/${dbName}`;
      await cleanupDatabase(dbUrl);
    }

    console.log("\n✓ All test databases cleaned up");
  } catch (error) {
    console.error("✗ Failed to list test databases");
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Main command handler
 */
async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  switch (command) {
    case "create":
      {
        const url = await createTestDatabase(arg);
        console.log(url);
      }
      break;

    case "migrate":
      if (!arg) {
        console.error("Usage: node scripts/migrations.mjs migrate <database-url>");
        process.exit(1);
      }
      await runMigrationsOnDatabase(arg);
      break;

    case "verify":
      await verifyMigrations();
      break;

    case "cleanup":
      await cleanupAllTestDatabases();
      break;

    default:
      console.log("Usage:");
      console.log("  node scripts/migrations.mjs create [name]        Create a test database");
      console.log("  node scripts/migrations.mjs migrate <db-url>    Run migrations");
      console.log("  node scripts/migrations.mjs verify              Verify migrations work");
      console.log("  node scripts/migrations.mjs cleanup             Clean up test databases");
      process.exit(1);
  }
}

main();
