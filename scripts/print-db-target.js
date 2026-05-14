/**
 * Print DB connection target after the same env + defaults as lib/config.js.
 * Use before `npm run migrate:prod` — does not open a Postgres connection.
 */
import '../lib/config.js';

const host = process.env.DB_HOST || 'localhost';
const port = process.env.DB_PORT;
const name = process.env.DB_NAME || 'users';
const user = process.env.DB_USER || '(unset)';

console.log('Database target (what migrate:prod / the app use after config defaults):');
console.log(`  NODE_ENV     ${process.env.NODE_ENV ?? '(unset)'}`);
console.log(`  DB_HOST      ${host}`);
console.log(`  DB_PORT      ${port ?? '(unset — migrate:prod will fail if still unset after config import)'}`);
console.log(`  DB_NAME      ${name}`);
console.log(`  DB_USER      ${user}`);
console.log('');
console.log('If DB_PORT looked wrong, set DB_PORT in .env or export it for this shell.');
