#!/usr/bin/env node

/**
 * Reset Database: Delete all games and characters
 * Keeps: users, auth data, settings, killshots
 *
 * Usage: node reset-db.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

(async () => {
  try {
    console.log('🗑️  Resetting database...');

    // Delete games and cascade to characters, game_state, etc
    await pool.query('DELETE FROM games');
    console.log('✅ Deleted all games (cascade deletes characters, game_state)');

    // Verify deletion
    const gamesCount = await pool.query('SELECT COUNT(*) FROM games');
    const charsCount = await pool.query('SELECT COUNT(*) FROM characters');

    console.log(`\n📊 Database state:`);
    console.log(`   Games: ${gamesCount.rows[0].count}`);
    console.log(`   Characters: ${charsCount.rows[0].count}`);
    console.log(`   Users: Preserved`);
    console.log(`   Killshots: Preserved`);

    console.log('\n✅ Database reset complete!');
    console.log('Ready for fresh start. Run test-harness.js to create test data.');

    process.exit(0);
  } catch (err) {
    console.error('❌ Reset failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
