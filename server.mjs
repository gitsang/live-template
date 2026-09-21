import { handler } from './build/handler.js';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const server = createServer(handler);

server.listen(port, host, () => {
	console.log(`[live-template] listening on http://${host}:${port}`);
});
