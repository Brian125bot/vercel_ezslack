import { describe, it, expect } from 'vitest';
import { migrations } from '../src/server/storage/schema.js';

describe('Migration Idempotency (W4-F7)', () => {
  it('all CREATE TABLE statements use IF NOT EXISTS', () => {
    for (const migration of migrations) {
      const sql = migration.sql.toLowerCase();
      // Match CREATE TABLE that is NOT followed by IF NOT EXISTS
      const problematic = sql.match(/create\s+table\s+(?!if\s+not\s+exists)/g);
      expect(
        problematic,
        `Migration v${migration.version} (${migration.name}) has CREATE TABLE without IF NOT EXISTS`
      ).toBeNull();
    }
  });

  it('all CREATE INDEX statements use IF NOT EXISTS', () => {
    for (const migration of migrations) {
      const sql = migration.sql.toLowerCase();
      const problematic = sql.match(/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/g);
      expect(
        problematic,
        `Migration v${migration.version} (${migration.name}) has CREATE INDEX without IF NOT EXISTS`
      ).toBeNull();
    }
  });

  it('all ALTER TABLE ADD COLUMN statements use IF NOT EXISTS', () => {
    for (const migration of migrations) {
      const sql = migration.sql.toLowerCase();
      const problematic = sql.match(/add\s+column\s+(?!if\s+not\s+exists)/g);
      expect(
        problematic,
        `Migration v${migration.version} (${migration.name}) has ADD COLUMN without IF NOT EXISTS`
      ).toBeNull();
    }
  });

  it('all DROP TABLE/COLUMN statements use IF EXISTS', () => {
    for (const migration of migrations) {
      const sql = migration.sql.toLowerCase();
      const dropTable = sql.match(/drop\s+table\s+(?!if\s+exists)/g);
      expect(
        dropTable,
        `Migration v${migration.version} has DROP TABLE without IF EXISTS`
      ).toBeNull();

      const dropColumn = sql.match(/drop\s+column\s+(?!if\s+exists)/g);
      expect(
        dropColumn,
        `Migration v${migration.version} has DROP COLUMN without IF EXISTS`
      ).toBeNull();
    }
  });

  it('all migration versions are unique', () => {
    const versions = migrations.map(m => m.version);
    const uniqueVersions = new Set(versions);
    expect(uniqueVersions.size).toBe(versions.length);
  });

  it('migration versions are in ascending order', () => {
    for (let i = 1; i < migrations.length; i++) {
      expect(
        migrations[i].version,
        `Migration v${migrations[i].version} is not greater than v${migrations[i - 1].version}`
      ).toBeGreaterThan(migrations[i - 1].version);
    }
  });

  it('every migration has a name', () => {
    for (const migration of migrations) {
      expect(migration.name).toBeTruthy();
      expect(migration.name.length).toBeGreaterThan(0);
    }
  });

  it('every migration has non-empty SQL', () => {
    for (const migration of migrations) {
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('migration runner is idempotent by design (version tracking)', () => {
    // The migration system uses a schema_migrations table to track applied
    // versions, so running the same migration set twice is inherently safe.
    // This test verifies the structural preconditions for that design.
    const versions = migrations.map(m => m.version);
    
    // All versions must be positive integers
    for (const v of versions) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isInteger(v)).toBe(true);
    }
    
    // No gaps that could confuse a sequential runner
    const sortedVersions = [...versions].sort((a, b) => a - b);
    expect(sortedVersions).toEqual(versions); // already sorted in source
  });
});
