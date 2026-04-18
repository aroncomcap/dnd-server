#!/usr/bin/env node

/**
 * Reset Database: Delete game instances and characters only
 * Preserves: users, auth data, house rules, killshots, all user-loaded data
 *
 * Usage: node reset-db.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

(async () => {
  try {
    console.log('🗑️  Resetting game instances and characters...');

    // Delete games (cascades to characters, game_state, channel_links, etc)
    await pool.query('DELETE FROM games');
    console.log('✅ Deleted all game instances');
    console.log('✅ Deleted all character sheets (cascade)');

    // Verify deletion
    const gamesCount = await pool.query('SELECT COUNT(*) FROM games');
    const charsCount = await pool.query('SELECT COUNT(*) FROM characters');
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const rulesCount = await pool.query('SELECT COUNT(*) FROM rules_corrections');
    const killshotsCount = await pool.query('SELECT COUNT(*) FROM killshots');

    console.log(`\n📊 Database state after reset:`);
    console.log(`   Games: ${gamesCount.rows[0].count}`);
    console.log(`   Characters: ${charsCount.rows[0].count}`);
    console.log(`   Users: ${usersCount.rows[0].count} (preserved)`);
    console.log(`   House Rules: ${rulesCount.rows[0].count} (preserved)`);
    console.log(`   Killshots: ${killshotsCount.rows[0].count} (preserved)`);
    console.log(`   Balances: Preserved`);
    console.log(`   Purchases: Preserved`);

    console.log('\n✅ Database reset complete!');
    console.log('Fresh start ready. All player data, house rules, and achievements preserved.');
    console.log('Run test-harness.js to create test game instances.');

    process.exit(0);
  } catch (err) {
    console.error('❌ Reset failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
