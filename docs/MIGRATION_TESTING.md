# Database Migration Testing Guide

This document describes how to run, verify, and test database migrations in disposable integration environments.

## Overview

The migration testing system provides:

- **Disposable test databases** - Automatically created and cleaned up PostgreSQL databases for testing
- **Migration validation** - Verify all migrations apply cleanly from an empty database
- **Constraint verification** - Test unique, foreign key, and not null constraints
- **Upgrade path testing** - Ensure fixture data survives schema migrations
- **Rollback verification** - Confirm migrations can be rolled back cleanly
- **CI integration** - Automated migration testing in GitHub Actions

## Quick Start

### Local Development

Run migration verification from the project root:

```bash
# Verify migrations apply from an empty database
pnpm prisma:migrations:verify

# Run full migration integration tests (requires PostgreSQL running locally)
pnpm prisma:migrations:test

# Clean up any test databases
pnpm prisma:migrations:cleanup
```

### CI/CD Pipeline

The CI pipeline automatically:

1. Creates a disposable PostgreSQL database
2. Verifies all migrations apply cleanly
3. Runs migration integration tests
4. Cleans up test databases

This runs in the `database-migrations` job of `.github/workflows/ci.yml`.

## Architecture

### Migration Testing Utilities

The `packages/testkit/src/database.ts` module provides utilities:

#### `createDisposableTestDatabase(baseUrl?)`

Creates a disposable test database with automatic cleanup.

```typescript
const { databaseUrl, cleanup, dbName } = await createDisposableTestDatabase();
try {
  // Use database
  await runMigrations(databaseUrl);
} finally {
  await cleanup();
}
```

**Parameters:**
- `baseUrl` - PostgreSQL maintenance database URL (defaults to `postgres` database)

**Returns:**
- `databaseUrl` - Connection string for the test database
- `cleanup` - Async function to drop the database
- `dbName` - Generated unique database name

#### `runMigrations(databaseUrl, schemaPath?)`

Runs Prisma migrations on a database.

```typescript
const { success, stdout, stderr } = await runMigrations(databaseUrl);
if (success) {
  console.log("Migrations completed");
}
```

**Parameters:**
- `databaseUrl` - Database connection string
- `schemaPath` - Path to `prisma/schema.prisma` (defaults to `prisma/schema.prisma`)

**Returns:**
- `success` - Boolean indicating migration success
- `stdout` - Command output
- `stderr` - Error output if any

#### `verifyMigrationsApplyFromEmpty(maintenanceDbUrl?, schemaPath?)`

Creates a disposable database, runs all migrations, and cleans up.

```typescript
const { success, dbName, databaseUrl } = await verifyMigrationsApplyFromEmpty();
```

**Returns:**
- `success` - Boolean indicating verification success
- `dbName` - Name of the temporary test database
- `databaseUrl` - Connection string (valid during migration only)

#### `verifyDatabaseConstraint(prismaClient, tableName, fixtureData, constraintType)`

Validates database constraints by testing constraint violations.

```typescript
const isEnforced = await verifyDatabaseConstraint(
  client,
  "seller",
  { walletAddress: "..." },
  "unique"
);
```

**Parameters:**
- `prismaClient` - Connected PrismaClient instance
- `tableName` - Table name to test
- `fixtureData` - Object with field values
- `constraintType` - `"unique"` | `"foreignKey"` | `"notNull"`

### Migration Scripts

The `scripts/migrations.mjs` script manages test databases:

```bash
# Create a disposable test database
node scripts/migrations.mjs create [name]

# Run migrations on a specific database
node scripts/migrations.mjs migrate <database-url>

# Verify migrations work from empty database
node scripts/migrations.mjs verify

# Clean up all test_* databases
node scripts/migrations.mjs cleanup
```

### Migration Integration Tests

Two comprehensive test suites verify migrations:

#### `prisma/migrations.integration.test.ts`

Tests migration history and constraint enforcement:

- All migrations apply from empty database
- Migrations are idempotent (can run multiple times)
- Seller table has correct structure and unique constraints
- Resources require valid seller foreign keys
- Payment attempts have unique constraints on `paymentHash` and `idempotencyKey`
- Settlements have unique constraint on `paymentAttemptId`
- Cascade delete removes child records when parent is deleted
- Resource versions have unique constraints on `(resourceId, version)`
- Seller domains have unique constraints on `(sellerId, domain)`
- Payment sessions have unique constraints on `contractSessionId`
- Receipts have unique constraints on `evidenceHash`

#### `prisma/migrations-rollback.integration.test.ts`

Tests upgrade paths and schema compatibility:

- Fixture data from early schemas (0001) survives upgrades
- All newer tables from later migrations exist and function correctly
- Payment session tables support upto scheme
- Audit and observability tables support correlation tracking
- Default values are applied for new NOT NULL columns
- Indexes are created for performance-critical columns
- JSON columns store and retrieve complex data structures
- Decimal precision is maintained for financial amounts

## Running Tests Locally

### Prerequisites

1. PostgreSQL 17+ running locally
2. Default credentials: `postgres:postgres@localhost:5432`
3. Node.js 24+

If your PostgreSQL is configured differently, set environment variables:

```bash
export MAINTENANCE_DB_URL="postgresql://user:password@host:port/postgres"
export MIGRATION_TEST_DATABASE_URL="postgresql://user:password@host:5432/test_db"
```

### Run All Migration Tests

```bash
pnpm prisma:migrations:test
```

This runs:
1. Migration verification (creates empty database and runs all migrations)
2. Integration tests on fresh database

### Run Individual Test Suites

```bash
# Just verify migrations apply cleanly
pnpm prisma:migrations:verify

# Run specific test file
vitest run prisma/migrations.integration.test.ts

# Run specific test
vitest run prisma/migrations.integration.test.ts -t "seller table has correct structure"
```

### Watch Mode (Development)

```bash
# Run tests in watch mode
vitest prisma/**/*.integration.test.ts
```

## CI/CD Integration

The `.github/workflows/ci.yml` includes a dedicated `database-migrations` job:

```yaml
database-migrations:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:17-alpine
      env:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
      options: >-
        --health-cmd pg_isready
        --health-interval 10s
        --health-timeout 5s
        --health-retries 5
      ports:
        - 5432:5432

  steps:
    - name: Verify migrations from empty database
      run: pnpm prisma:migrations:verify

    - name: Run migration integration tests
      run: pnpm prisma:migrations:test

    - name: Clean up test databases
      if: always()
      run: pnpm prisma:migrations:cleanup
```

### How It Works

1. **Setup**: GitHub Actions spins up a PostgreSQL 17 service container
2. **Verification**: `pnpm prisma:migrations:verify` creates a disposable database and runs migrations
3. **Testing**: `pnpm prisma:migrations:test` runs all integration tests
4. **Cleanup**: `pnpm prisma:migrations:cleanup` removes test databases (always runs, even on failure)

## Best Practices

### Adding New Migrations

When adding a new migration:

1. **Create the migration**: `pnpm prisma:migrate`
2. **Test locally**: Run `pnpm prisma:migrations:verify` to ensure it applies cleanly
3. **Test fixtures**: Run `pnpm prisma:migrations:test` to verify constraints
4. **Update tests**: Add test cases to `prisma/migrations.integration.test.ts` if you add:
   - New tables
   - New unique constraints
   - New foreign keys
   - Cascade delete relationships

### Writing Migration Tests

When testing fixture data and constraints:

```typescript
// 1. Create a seller (parent table)
const seller = await client.seller.create({
  data: { /* ... */ }
});

// 2. Create a resource with foreign key
const resource = await client.resource.create({
  data: {
    sellerId: seller.id,
    // ... other required fields
  }
});

// 3. Test the constraint
await expect(
  client.resource.create({
    data: {
      sellerId: "invalid-id", // Foreign key violation
      // ...
    }
  })
).rejects.toThrow();
```

### Handling Failed Migrations

If migrations fail in CI:

1. **Check logs**: Review the failed job output in GitHub Actions
2. **Test locally**: Run `pnpm prisma:migrations:test` locally with the same PostgreSQL version
3. **Debug**: Add temporary logs to `scripts/migrations.mjs` or test files
4. **Verify**: Ensure new migrations don't conflict with existing schema

## Troubleshooting

### Tests fail: "Cannot find module '@lumenbazaar/testkit'"

The testkit package may not be installed or exported. Verify:

```bash
# Ensure dependencies are installed
pnpm install

# Verify testkit exports are in packages/testkit/src/index.ts
cat packages/testkit/src/index.ts
```

### Database already exists error

Test databases can accumulate if cleanup fails. Clean them up:

```bash
# Remove all test_* databases
pnpm prisma:migrations:cleanup

# Or manually
psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS test_12345_abc;"
```

### Migration takes too long

If migrations timeout in CI:

1. Check for long-running data migrations in `.sql` files
2. Consider breaking into separate migrations
3. Increase timeout in `.github/workflows/ci.yml` if needed

### PostgreSQL connection refused

If running locally and tests fail to connect:

```bash
# Verify PostgreSQL is running
psql -U postgres -d postgres -c "SELECT 1;"

# Check connection parameters
echo "MAINTENANCE_DB_URL=${MAINTENANCE_DB_URL}"
echo "MIGRATION_TEST_DATABASE_URL=${MIGRATION_TEST_DATABASE_URL}"
```

## Migration History

Current migration structure:

- **0001_core_catalog** - Seller, Resource, PaymentRequirement tables
- **0002_payment_records** - PaymentAttempt, Settlement, Receipt tables
- **0003_discovery_operations** - Discovery, CatalogEvent, CatalogRun tables
- **0004_upto_sessions** - PaymentSession, UptoSessionSettlement for upto scheme
- **0005_durable_payment_persistence** - Additional payment persistence columns
- **0006_settlement_reconciliation** - Settlement reconciliation and status tables
- **0007_observability_correlation** - AuditLog, correlation tracking tables

All migrations apply in sequence and are tested to work from an empty database.

## References

- [Prisma Migration Documentation](https://www.prisma.io/docs/orm/prisma-migrate)
- [GitHub Actions PostgreSQL Service](https://docs.github.com/en/actions/using-containerized-services/creating-postgresql-service-containers)
- [LumenBazaar Backend Repository](https://github.com/LumenRoute/lumenbazaar-backend)
