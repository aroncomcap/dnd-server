#!/usr/bin/env node
/**
 * DESTRUCTIVE: Delete all games and characters from PostgreSQL
 *
 * WARNING: This CANNOT be undone. All game data will be permanently deleted.
 *
 * Usage: node cleanup-all-data.js
 */

const db = require('./db');

async function cleanup() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  DELETE ALL GAMES AND CHARACTERS          ║');
  console.log('║  WARNING: THIS CANNOT BE UNDONE!          ║');
  console.log('╚════════════════════════════════════════════╝\n');

  try {
    // Get counts before deletion
    const gamesRes = await db.pool.query('SELECT COUNT(*) as count FROM games');
    const charsRes = await db.pool.query('SELECT COUNT(*) as count FROM characters');
    const gamesCount = gamesRes.rows[0]?.count || 0;
    const charsCount = charsRes.rows[0]?.count || 0;

    console.log(`Current state:`);
    console.log(`  Games: ${gamesCount}`);
    console.log(`  Characters: ${charsCount}\n`);

    if (gamesCount === 0 && charsCount === 0) {
      console.log('✅ No data to delete. Database is already clean.');
      await db.pool.end();
      process.exit(0);
    }

    // Confirm deletion
    console.log('🚨 About to DELETE:');
    console.log(`  - ${gamesCount} game(s)`);
    console.log(`  - ${charsCount} character(s)`);
    console.log('\nTo proceed, set: export CONFIRM_DELETE=yes');
    console.log('Then run this script again.\n');

    if (process.env.CONFIRM_DELETE !== 'yes') {
      console.log('❌ Deletion cancelled. Set CONFIRM_DELETE=yes to proceed.');
      await db.pool.end();
      process.exit(1);
    }

    // Delete related data first (foreign key constraints)
    console.log('🔄 Deleting related data...');
    await db.pool.query('DELETE FROM game_state WHERE game_id IS NOT NULL');
    await db.pool.query('DELETE FROM channel_links WHERE game_id IS NOT NULL');
    await db.pool.query('DELETE FROM rules_corrections WHERE game_id IS NOT NULL');
    await db.pool.query('DELETE FROM monster_templates WHERE game_id IS NOT NULL');
    await db.pool.query('DELETE FROM bug_reports WHERE game_id IS NOT NULL');

    // Delete characters
    console.log('🔄 Deleting characters...');
    const delCharsRes = await db.pool.query('DELETE FROM characters WHERE game_id IS NOT NULL');
    console.log(`   Deleted: ${delCharsRes.rowCount} character(s)`);

    // Delete games
    console.log('🔄 Deleting games...');
    const delGamesRes = await db.pool.query('DELETE FROM games');
    console.log(`   Deleted: ${delGamesRes.rowCount} game(s)`);

    // Verify deletion
    const finalGames = await db.pool.query('SELECT COUNT(*) as count FROM games');
    const finalChars = await db.pool.query('SELECT COUNT(*) as count FROM characters');
    const finalGameCount = finalGames.rows[0]?.count || 0;
    const finalCharCount = finalChars.rows[0]?.count || 0;

    console.log('\n✅ CLEANUP COMPLETE');
    console.log(`   Games remaining: ${finalGameCount}`);
    console.log(`   Characters remaining: ${finalCharCount}`);

    if (finalGameCount === 0 && finalCharCount === 0) {
      console.log('\n🎉 Database is now clean!');
    }

    await db.pool.end();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    await db.pool.end();
    process.exit(1);
  }
}

cleanup();
