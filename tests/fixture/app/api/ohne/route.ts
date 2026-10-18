import { ohne } from '../../../lib/ohne';

export const POST = ohne.webhook(process.env.OHNE_WEBHOOK_SECRET);
