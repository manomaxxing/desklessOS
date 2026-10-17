// A new TOTP secret for the admin login. Put it in your authenticator app (the
// otpauth:// link, or type the secret), then set it on the server:
//   put ADMIN_TOTP_SECRET=<secret> in deploy/env.production (with ADMIN_CODE set as well)
//   npm run admin:totp
import { generateSecret, otpauthUri } from "../src/admin/auth.ts";

const secret = generateSecret();
console.log(`ADMIN_TOTP_SECRET=${secret}`);
console.log(otpauthUri(secret, { label: process.argv[2] || "admin" }));
console.log("This is a credential: don't paste it into chats or commit it.");
