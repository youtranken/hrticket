/* Break-glass CLI (Story 1.7): rescue an account directly on the host when even
 * SSA is locked out (e.g. SSA's own OTP + email are stuck). Writes audit with a
 * system:break-glass actor. Run: node dist/cli/rescue.js --email=x --reset-password --remove-otp
 */
import { eq } from 'drizzle-orm';
import { db, sql } from '../infra/db/db';
import { users } from '../infra/db/schema';
import { generateTempPassword, hashPassword } from '../infra/crypto/password';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const email = arg('email');
  if (!email) {
    console.error('Usage: rescue --email=<email> [--reset-password] [--remove-otp]');
    process.exit(2);
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }

  const set: Record<string, unknown> = {};
  let temp: string | undefined;
  if (flag('reset-password')) {
    temp = generateTempPassword();
    set.passwordHash = await hashPassword(temp);
    set.mustChangePassword = true;
  }
  if (flag('remove-otp')) set.otpEnabled = false;

  if (Object.keys(set).length === 0) {
    console.error('Nothing to do — pass --reset-password and/or --remove-otp');
    process.exit(2);
  }

  await db.update(users).set(set).where(eq(users.id, user.id));
  // Audit table is created by custom SQL; insert directly (system:break-glass actor).
  await sql`INSERT INTO audit_log (actor_label, action, object_type, object_id)
            VALUES ('system:break-glass', 'account.rescue', 'user', ${user.id})`;

  if (temp) console.log(`Temporary password for ${email}: ${temp}`);
  console.log('Rescue complete.');
  await sql.end();
  process.exit(0);
}

void main();
