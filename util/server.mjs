'use strict';
import https from 'https';
import fs from 'fs';
import { debugLog } from './logger.mjs';
import { checkGetRoute, checkPostRoute } from './router.mjs';

const HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
const PORT = process.env.PORT || 3000;

const options = {
    key: fs.readFileSync("./.private/key.pem"),
    cert: fs.readFileSync("./.private/cert.pem")
};

const server = https.createServer(options);

server.on('request', (req, res) => {

    // TODO only allow site main origin
    /* if(req.headers.origin !== process.env.FULL_ORIGIN || req.headers.origin !== 'https://localhost:3000') {
        debugLog(3, 'Recieved request from Invalid Origin: ', req.headers.origin)
        return res.writeHead(418).end();
    } */

    if(req.method === 'GET') {
        debugLog(3, 'Recieved GET req..');
        checkGetRoute(req, res);
    }

    if(req.method === 'POST') {
        debugLog(3, 'Recieved POST req..');
        checkPostRoute(req, res);
    }
});

server.on('clientError', (err, socket) => {
    socket.end('HTTPS 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOSTNAME, () => {
    debugLog(1, `Server running at https://${HOSTNAME}:${PORT}/`);
    debugLog(1, 'Developed by: ', process.env.DEV_NAME);
    debugLog(1, 'Now Listening...');
});

// ? Export Module JS
export default 'server.mjs';