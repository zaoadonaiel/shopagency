// Cloudflare Workers entry point. The same Express app as `npm start`, served through the
// Workers Node.js compatibility layer. A Cron Trigger (see wrangler.jsonc) runs tick() every minute,
// in place of the setInterval that `npm start` uses.
import { httpServerHandler } from 'cloudflare:node';
import app from './server.js';
import jobs from './jobs.js';

const PORT = 8080;
app.listen(PORT);

export default {
  ...httpServerHandler({ port: PORT }),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(jobs.tick().catch((e) => console.error('tick failed', e)));
  },
};
