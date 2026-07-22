import { db } from '../firebase.js';

const health = await db.getHealth(true);
console.log(JSON.stringify(health, null, 2));
process.exitCode = health.ok ? 0 : 1;
