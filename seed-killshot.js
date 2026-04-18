#!/usr/bin/env node

/**
 * Seed a killshot to the database
 * Usage: node seed-killshot.js <image-file-path> [character] [enemy] [description]
 *
 * Example:
 *   node seed-killshot.js ./dragon.jpg "Bjorn" "Ancient Red Dragon" "Critical hit to the eye slays the beast"
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const imagePath = process.argv[2];
const characterName = process.argv[3] || 'Unknown Hero';
const enemyName = process.argv[4] || 'Unknown Foe';
const description = process.argv[5] || 'A dramatic victory';

if (!imagePath) {
  console.error('Usage: node seed-killshot.js <image-file-path> [character] [enemy] [description]');
  process.exit(1);
}

if (!fs.existsSync(imagePath)) {
  console.error(`Error: Image file not found: ${imagePath}`);
  process.exit(1);
}

const imageBuffer = fs.readFileSync(imagePath);
const base64Image = imageBuffer.toString('base64');
const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
const imageUrl = `data:${mimeType};base64,${base64Image}`;

console.log(`Loading image: ${imagePath}`);
console.log(`Character: ${characterName}`);
console.log(`Enemy: ${enemyName}`);
console.log(`Description: ${description}`);
console.log(`Image size: ${(imageUrl.length / 1024 / 1024).toFixed(2)}MB`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

(async () => {
  try {
    const result = await pool.query(
      `INSERT INTO killshots
       (game_id, game_name, character_name, player_user_id, enemy_name, moment_type, description, image_url, drama_score, game_system, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING id`,
      [
        null,                           // game_id (null = system-wide)
        'Hall of Fame',                 // game_name
        characterName,                  // character_name
        null,                           // player_user_id
        enemyName,                      // enemy_name
        'nat20_boss_kill',              // moment_type
        description,                    // description
        imageUrl,                       // image_url
        10,                             // drama_score (max = 10)
        'dnd5e',                        // game_system
      ]
    );

    console.log(`\n✅ Killshot seeded! ID: ${result.rows[0].id}`);
    console.log('It will appear in the Hall of Fame on the lobby page.');
    process.exit(0);
  } catch (err) {
    console.error('Database error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
