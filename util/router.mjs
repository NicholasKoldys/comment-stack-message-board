'use strict';
import { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs/promises';
import { debugLog } from './logger.mjs';
import { isLoginCreationValid, createLogin, getConfirmedLogin, updateLoginConfirmed } from '../db/db-login.mjs';
import { createECode, getEcodeWLoginNonce, deleteECode } from '../db/db-ecode.mjs';
import { createNonce, renewNonce, deleteNonce } from '../db/db-nonce.mjs';
import { createComment } from '../db/db-comments.mjs';
import { createJWT, isJWTValid, parseJWT } from '../.private/secure/jwtokenizer.mjs';
import { sterilizeBasicString, sterilizeEmail, sterilizeECode, sterlizeUrlCode } from '../.private/secure/sterilizer.mjs';
import { randomNumericString, randomCharString, hashNonce, checkHash } from '../.private/secure/code-generator.mjs';
import { writeAuthorizationToken, sendMail } from './emailer.mjs';
import { setValuesInHTML, getURLArg, getGoogleAuthCode, getClientCookieMap } from './common-parsers.mjs';
import { exportCommentPage } from '../.private//controller/comment-controller.mjs';
import { sterilizeNonce } from '../.private/secure/sterilizer.mjs';

const fileLocationMap = new Map( [
    [ '/', [ './public/view/index.html', "text/html" ] ],
    [ '/login', [ './public/view/login.html', "text/html" ] ],
    [ '/signup', [ './public/view/signup.html', "text/html"] ],
    [ '/confirm+email', [ './public/view/email-confirmation.html', "text/html"] ],
    [ '/comments', [ './public/view/commenting.html', "text/html" ] ],
    [ '/css/style.css', [ './public/resources/css/style.css', "text/css" ] ],
    [ '/js/javascript.js', [ './public/resources/js/javascript.js', "application/javascript" ] ],
    [ '/favicon.ico', [ './public/resources/images/comment-stack-fav.svg', "image/svg+xml" ] ],
] );

/**
 * 
 * @param {IncomingMessage} req 
 * @param {ServerResponse} res 
 */
async function checkGetRoute(req, res) {
    try {

        if(req.url === '/') {
            debugLog(3, 'Entering get.request "/"');
            debugLog(7, 'Checking for JWT.');
            let cookieMap = getClientCookieMap(req.headers.cookie, [ 'Access-Token' ]);
            if(cookieMap != null) {
                if( isJWTValid( cookieMap.get('Access-Token'), false ) ) {
                    await processThreadPage(res, '/comments');
                    return ;
                }
            }
            await processThreadPage(res, '/');
            return ;
        }

        if(req.url === '/login') {
            await getStaticPage(200, '/login', res);
            return ;
        }

        if(req.url.includes('/confirm+email')) {
            debugLog(3, 'Entering get.request "/confirm+email"');
            let isValid = await isEmailAttemptValid(req.headers.cookie);
            if(isValid) {
                debugLog(7, 'Cookie is good.');
                await getStaticPage(200, '/confirm+email', res);
            } else {
                // ? 403 : Forbidden
                declineRoute(403, res, 'Please Follow sign-up procedure.');
            }
            return ;
        }

        if(req.url === '/signup') {
            debugLog(3, 'Entering get.request "/signup"');
            // * If user attempts to signup with attempt-email waiting, user redirected to confirm+email link
            let isCurrentlyValid = await isEmailAttemptValid(req.headers.cookie);
            if(isCurrentlyValid) {
                // ? 302 : Redirect Found Resource
                await forwardContent(302, res, Buffer.from('/confirm+email', 'utf-8'), 'text/plain',    
                    {
                        "Location" : "/confirm+email" // ? Must set location for redirect to work properly.
                    } );
                    
            } else {
                await getStaticPage(200, '/signup', res);
            }
            return ;
        }

        // ! Dangerous path. Need to sterilize url.
        /* if(req.url === '/gauth' || req.url.includes('/gauth')) {
            debugLog(6, 'Get gauth recieved: ', req.url);
            await getStaticPage(302, '/', res);

            const gAuthCOde = getGoogleAuthCode(req.url);
            await writeAuthorizationToken(gAuthCOde);
            return ;
        } */

        if(req.url === '/css/style.css') {
            await getStaticPage(200, '/css/style.css', res);
            return ;
        }

        if(req.url === '/js/javascript.js') {
            await getStaticPage(200, '/js/javascript.js', res);
            return ;
        } 

        if(req.url === '/favicon.ico') {
            await getStaticPage(200, '/favicon.ico', res);
            return ;


        } else {
            // TODO write unrecognized GET to log.
            debugLog(3, 'GET Attempted: ', req.url);
            throw 'Un-recognized GET.'
        }
        
    } catch (e) {
        // * Throw exception so default 404 is sent.
        debugLog(3, 'Check GET Route Failed: ', e, ' | ', e.stack);
        // ? 404 : Page Not Found
        return declineRoute(404, res, 'Page Does Not Exist');
    }
}

/**
 * 
 * @param {IncomingMessage} req 
 * @param {ServerResponse} res 
 */
async function checkPostRoute(req, res) {
    try {

        if(req.url === '/login') {
            debugLog(3, 'Entering post.request "/login"');
            await processLoginRoute(req, res);
            return ;
        }
    
        if(req.url === '/signup') {
            debugLog(3, 'Entering post.request "/signup"');
            await processSignupRoute(req, res);
            return ;
        }
    
        if(req.url.includes('/confirm+email')) {
            debugLog(3, 'Entering post.request "/confirm+email"');
            await processConfirmEmailRoute(req, res);
            return ;
        }

        if(req.url == '/add+comment') {
            debugLog(3, 'Entering post.request "/add+comment"', req.socket.bytesRead);
            // * Decline request if comment is too long
            if(req.socket.bytesRead > 891) { 
                declineRoute(200, res, 'Comment Too Long');
                return ;
            }
            let cookieMap = getClientCookieMap(req.headers.cookie, [ 'Access-Token' ]);
            if(cookieMap != null) {
                let jwtToken = parseJWT( cookieMap.get('Access-Token') );
                if( isJWTValid( jwtToken, true ) ) {
                    let payload = JSON.parse( jwtToken.payload );
                    await processCommentPost(req, res, payload.client_id );
                    return ;
                }
            }
            // ? 401 : Un-Authorized Access
            return declineRoute(401, res, "Un-authorized Access.");

        } else {
            // TODO write unrecognized post to log.
            debugLog(3, 'POST Attempted: ', req.url);
            throw 'Un-recognized POST.'
        }

    } catch (e) {
        debugLog(3, 'Check POST Route Failed: ', e, ' | ', e.stack);
        // ? 400 : Bad Request
        return declineRoute(400, res, "Bad Request");
    }
}

/**
 * 
 * @param {Number} status
 * @param {String } route 
 * @param {ServerResponse} response
 * @param {Object} [addHeaders]
 * @returns status, setStaticResponse, and contentType linked with response with optional headers to client
 */
async function getStaticPage(status, route, response, addHeaders) {
    try {
        let mapValueArr = fileLocationMap.get(route);
        // ? Async File Read
        let fileContents = await fs.readFile( mapValueArr[0] );

        return forwardContent(status, response, fileContents, mapValueArr[1], addHeaders);
        
    } catch (e) { debugLog(1, 'Static Route Fetch Error: ', e, ' | ', e.stack); }
}

/**
 * 
 * @param {Number} status 
 * @param {String} route 
 * @param {ServerResponse} response 
 * @param {Function} asyncContentFetch 
 * @param {Object<header, value>} [addHeaders]
 * @returns status, dynamicallyCreated Content, and optional headers to client
 */
async function getDynamicCommentPage(status, route, response, asyncContentFetch, addHeaders) {
    try {
        let mapValueArr = fileLocationMap.get(route);
        // ? Async File Read
        let fileContents = await fs.readFile( mapValueArr[0] );

        //TODO replace with asyncContentFetch
        let dynamicContent = await exportCommentPage( fileContents );

        return forwardContent(status, response, dynamicContent, mapValueArr[1], addHeaders);

    } catch (e) { debugLog(1, 'Dyanmic Route Fetch Error : ', e, ' | ', e.stack); }
}

/**
 * 
 * @param {Number} status 
 * @param {ServerResponse} response 
 * @param {Buffer} outputContent
 * @param {String} contentType
 * @param {Object<header, value>} [addHeaders]
 * @returns status, content, and contentType with included optional headers to client
 */
function forwardContent(status, response, outputContent, contentType, addHeaders) {

    try {
        response.statusCode = status;
        response.setHeader("Content-Length", Buffer.byteLength(outputContent));
        response.setHeader("Content-Type",  contentType);

        if( addHeaders ) {
            // TODO figure out why (let [hdr, val] in addHeaders) wont work without Object.entries.
            for(let [hdr, val] of Object.entries(addHeaders)) {
                response.setHeader(hdr, val);
            }
        }

        return response.end(outputContent);
        
    } catch(e) { debugLog(7, 'Failed to ForwardContent: ', e, ' | ', e.stack); }
}

/**
 * 
 * @param status 
 * @param response 
 * @param message 
 * @returns utf-8 buffered message, text/plain content type to client
 */
async function declineRoute(status, response, message) {
    return forwardContent(status, response, Buffer.from(message, 'utf-8'), 'text/plain');
}

/**
 * Removes used cookies associated with server responses.
 * @returns 403 : Forbidden Access to client
 */
function sendClearedCookies(status) {
    let cookieArr = [
        `Username=${0}; Expires=${0}; Max-Age=${0}; Path=/; Secure; HttpOnly`, 
        `Attempt-Email=${0}; Expires=${0}; Max-Age=${0}; Path=/; Secure; HttpOnly`, 
        `Confirm-Nonce=${0}; Expires=${0}; Max-Age=${0}; Path=/; Secure; HttpOnly`
    ];

    return forwardContent( status, res, Buffer.from('Please retry sign-up process again.', 'utf-8'), 'text/plain', { "Set-Cookie" : cookieArr } );
}

/**7
 * @param {Request} reqUrl
 * @returns {String} email
 */
async function isEmailAttemptValid(cookie) {
    try {
        let cookieMap = getClientCookieMap(cookie, ['Confirm-Nonce', 'Username', 'Attempt-Email']);
        if(cookieMap == null) { throw 'Browser did not have proper cookie.'; }

        // TODO check exp dates?
        let isValid = await isLoginCreationValid( cookieMap.get('Username'), cookieMap.get('Attempt-Email') );
        debugLog(6, `Email-Attempt with: ${cookieMap.get('Username')}, ${cookieMap.get('Attempt-Email')}, isValid? = ${isValid}.`);
        if(!isValid) { throw 'Login has already been confirmed.'; }

        return true;

    } catch (e) { debugLog(3, 'isEmailAttemptValid Failed: ', e, ' | ', e.stack); return false; }
}

/**
 * 
 * @param {IncomingMessage} req 
 * @param {ServerResponse} res 
 */
async function processLoginRoute(req, res) {
    let postData = '';

    req.on('data', /* node js readableStream instance */ (chunk) => {
        postData += chunk;
    });

    req.on("end", async () => {
        try {
            // * Use if parsing application/x-www-form-urlencoded
            //let loginData = new URLSearchParams(postData);

            // * Use if using preferred JSON
            debugLog(6, 'Recieved data: ', postData);
            let loginData = JSON.parse(postData);

            //Optional syntax so string error doesnt cause issue.
            let testName = loginData.name?.replace(/"/g, '');
            let testPwd = loginData.pwd?.replace(/"/g, '');
            if(testName == null || testPwd == null) { throw 'Un-Authorized'; }
            debugLog(6, 'Login recieved data: Name: ', testName, ' | Pwd: ', testPwd);

            let sterileName = sterilizeBasicString(testName);
            let sterilePwd = sterilizeBasicString(testPwd);

            if(sterileName != testName || sterilePwd != testPwd || sterileName == '' || sterilePwd == '') {
                debugLog(6, 'item did not pass standards: Name: ', testName, ' | Pwd: ', testPwd);
                throw 'Un-Authorized';
            }

            let confirmedUser = await getConfirmedLogin(sterileName, sterilePwd);
            debugLog(3, 'Found confirmed email: ', confirmedUser ? true : false);
            if(confirmedUser == null) { throw 'Un-Authorized'; }
            debugLog(6, "Confirmed User: ", confirmedUser.name)

            // confirmedUser = JSON.parse( confirmedUser );
            let jwtoken = createJWT(confirmedUser.id, confirmedUser.name, confirmedUser.email);

            // ? 24 hr exp
            let jwtExp = Date.now() + 1;

            let cookieStr = `Access-Token=${jwtoken}; Expires=${jwtExp}; Path=/; Secure; HttpOnly`;

            // ? 302 : Found
            return forwardContent( 200, res, Buffer.from('', 'utf-8'), 'text/plain', 
                { 
                    "Set-Cookie" : cookieStr, 
                    'Location' : '/'
                } );

        } catch (e) {
            debugLog(3, 'Login Failed: ', e, ' | ', e.stack);
            // * Un-Authorized is a common 
            if(e == 'Un-Authorized') {
                // return declineRoute( 401, res, 'Un-Authorized' );
                return declineRoute( 401, res, '' );
            }
            return declineRoute( 500, res, 'Backend Error' );
        }
    });
}

/**
 * 
 * @param {IncomingMessage} req 
 * @param {ServerResponse} res 
 */
async function processSignupRoute(req, res) {
    let postData = '';

    req.on('data', /* node js readableStream instance */ (chunk) => {
        postData += chunk;
    });

    req.on("end", async () => {
        try {
            postData = JSON.parse(postData);

            let testName = JSON.stringify(postData.name).replace(/"/g, '');
            let testEmail = JSON.stringify(postData.email).replace(/"/g, '');
            let testPwd = JSON.stringify(postData.pwd).replace(/"/g, '');

            debugLog(6, 'Signup recieved data: Name: ', testName, ' | Email: ', testEmail, ' | Pwd: ', testPwd);

            let sterileName = sterilizeBasicString(testName);
            let sterileEmail = sterilizeEmail(testEmail);
            let sterilePwd = sterilizeBasicString(testPwd);

            if(sterileName != testName || sterileEmail != testEmail || sterilePwd != testPwd || sterileName == '' | sterileEmail == '' || sterilePwd == '') {
                throw 'Item did not pass standards.';
            }

            let loginId = Number.parseInt( await createLogin(sterileName, sterilePwd, sterileEmail) );
            debugLog(7, 'Is login created: ', loginId, loginId != null ? true : false);
            if(loginId == null) throw 'Login was not added.';

            let go = true;
            let it = 0;
            let genECode = '';
            let ecodeId = 0;
            while(go) {
                genECode = randomNumericString(8);
                if(genECode == null) throw 'Failed to make randNumStr.';

                // TODO show user waiting meter based on loading times
                ecodeId = Number.parseInt( await createECode(genECode, loginId) );
                if( (ecodeId != 0 && ecodeId != null) || it > 3) {
                    go = false;
                } else {
                    it++;
                }
            }
            if(ecodeId == 0 || ecodeId == null) throw 'Ecode was not added.';
            debugLog(7, 'Code finally generated: ', genECode, ' after iterations: ', it);

            let genNonce = randomCharString(16);
            if(genNonce == null) throw 'Nonce was not generated.';
            let nonceExp = await createNonce(ecodeId, genNonce);
            if(nonceExp == null) throw 'Nonce was not added.';
            let publicNonce = hashNonce(genNonce, new Date(nonceExp).toISOString());
            if(publicNonce == null) throw 'Hashing public nonce failed.';

            // * 5-day cookie
            let nameExp = new Date();
            nameExp.setDate(nameExp.getDate() + 5);

            debugLog(7, 'Login is created and email sent: ECode: ', genECode, ' | Hashed Nonce: ', publicNonce);

            // * USERNAME AND ATTEMPT-EMAIL Cookies are used in signup page accessibility check isEmailAttemptValid().
            let cookieArr = [
                `Confirm-Nonce=${publicNonce}; Expires=${nonceExp}; Path=/; Secure; HttpOnly`, 
                `Attempt-Email=${sterileEmail}; Expires=${nonceExp}; Path=/; Secure; HttpOnly`, 
                `Username=${sterileName}; Expires=${nameExp}; Path=/; Secure; HttpOnly`
            ];

            // ? 302 : Found
            forwardContent( 200, res, Buffer.from('', 'utf-8'), 'text/plain', 
                {
                    "Set-Cookie" : cookieArr, 
                    "email-attempt" : sterileEmail, // * email-attempt header is used in the signup html, to create the url for user readability
                    "Location" : '/'
                } );

            let confirmationEmail = await setValuesInHTML('confirmation-email.html', {
                '#CODE#' : genECode
            });
            let result = await sendMail(sterileEmail, '☑️ Email Confirmation for Comment-Stack-Message', '', confirmationEmail);
            if(result == null) { throw 'Unable to send email to activate email'; }
            debugLog(7, 'Confirmation email has been: ', result.labelIds[0]);

        } catch (e) {
            debugLog(3, 'SignUp Failed: ', e, ' | ', e.stack);
            // ? 400 : Bad Request
            return declineRoute(400, res, 'Name, Email, Password cannot be accepted.');
        }
    });
}

/**
 * 
 * @param {IncomingMessage} req 
 * @param {ServerResponse} res 
 */
async function processConfirmEmailRoute(req, res) {

    function ExpiredNonceException(val) {
        this.message = 'Expired-Nonce';
        // this.ecode_id = ecodeId;
        this.login_id = val
        this.name = 'ExpiredNonceException_CMS';
    }

    let postData = '';

    req.on('data', /* node js readableStream instance */ (chunk) => {
        postData += chunk;
    });

    req.on("end", async () => {
        try {
            postData = JSON.parse(postData);

            // * 1 - Test for appropriate cookies
            let cookieMap = getClientCookieMap(req.headers.cookie, ['Confirm-Nonce', 'Username', 'Attempt-Email']);
            if(cookieMap?.size != 3) { throw 'Unable to process request.'; }

            // * 1 - A - Test Username
            let testName = cookieMap.get('Username');
            let sterileNameAttempt = sterilizeBasicString( testName );
            if(testName != sterileNameAttempt || sterileNameAttempt == '') { throw 'Something went wrong.'; }

            // * 1 - B - Test Attempt-Email
            let testEmail = cookieMap.get('Attempt-Email');
            let sterileEmailAttempt = sterilizeEmail( testEmail );
            if(testEmail != sterileEmailAttempt || sterileEmailAttempt == '') { throw 'Something went wrong.'; }

            // * 1 - C - Test Nonce
            let testNonce = cookieMap.get('Confirm-Nonce');
            let confirmNonce = sterilizeNonce( testNonce );
            if(testNonce != confirmNonce || confirmNonce == '') { throw 'Something went wrong.'; }

            // * 2 - Test if code is properly formatted
            let testCode = JSON.stringify(postData.ecode).replace(/"/g, '');
            debugLog(6, 'E-Code confirmation recieved data: E-Code: ', testCode);
            let sterileEcode = sterilizeECode(testCode);
            if(sterileEcode != testCode || sterileEcode == '') { throw 'Incorrect-Ecode'; }

            // * 3 - Use Ecode to retrieve link to Nonce and Login.
            let verifiedData = await getEcodeWLoginNonce( sterileEcode, sterileNameAttempt, sterileEmailAttempt );
            if(verifiedData == null) { throw 'Something went wrong.'; }

            // * 3 - ifExpired - Restart signup
            if(verifiedData.nonce_exp < Date.now()) {
                // TODO Change ExpireException based on needs
                throw new ExpiredNonceException(verifiedData.login_id);
            }

            // * 4 - Test if Nonce is valid.
            let isHashValid = checkHash(confirmNonce, verifiedData.nonce_code, new Date(verifiedData.nonce_exp).toISOString());
            debugLog(6, 'is PublicNonce Hash Valid? : ', isHashValid);
            if(!isHashValid) { throw 'Something went wrong.'; }

            // * 5 - Confirmation Verified, update database entries and reward JWT
            // ! Must keep in order or db cascade issue.
            updateLoginConfirmed(verifiedData.login_id).then( () => {
                deleteNonce(verifiedData.ecode_id).then( () => {
                    deleteECode(verifiedData.login_id).then( () => {

                        let jwtoken = createJWT(verifiedData.login_id, verifiedData.login_name, verifiedData.login_email);

                        // ? 24 hr exp
                        let jwtExp = Date.now() + 1; // * Check jwt::reateJWT() if changed

                        let cookieArr = [
                            `Access-Token=${jwtoken}; Expires=${jwtExp}; Path=/; Secure; HttpOnly`,
                            `Confirm-Nonce=${0}; Expires=${0}; Max-Age=${0}; Path=/; Secure; HttpOnly`
                        ];

                        // ? 201 : Created
                        return forwardContent( 201, res, Buffer.from('', 'utf-8'), 'text/plain', 
                            { 
                                "Set-Cookie" : cookieArr,
                                "Location" : '/'
                            } );
                    });
                });
            });

        } catch (e) {
            debugLog(3, 'Confirm Email Failed: ', e, ' | ', e.stack);
            if(e.message == 'Something went wrong.') {
                // delete all cookies and send strong error to restart signup
                // show alternate page with instructions.
                // return declineRoute(404, res, '');
                // TODO TEMP 404
                return sendClearedCookies(404);
            }
            if(e.message == 'Incorrect-Ecode') {
                // * Allow client to retry
                // ? 400 : Bad Request
                return declineRoute(400, res, '');
            }
            if(typeof e == ExpiredNonceException) {
                // TODO redo sign-up process and resend confirmation email and mark resend exp on ammount of emails sent.
                // re-Create NONCE > reGenCode > reExp
                // * 1 day extension
                /* let extendedExp = new Date();
                extendedExp.setDate(extendedExp.getDate() + 1);

                let renewedNonce = renewNonce(e.ecode_id, randomCharString(16), extendedExp);
                let publicNonce = hashNonce(renewedNonce.code, new Date(renewedNonce.exp).toISOString());
                if(publicNonce == null) throw 'Hashing public nonce failed.'; */

                //TODO TEMP DELETE , instead SEND NEW ECODE
                await deleteLogin(e.login_id);
                // TODO TEMP 303 : See Other , instead show prompt
                return sendClearedCookies(303);
            }
            // ? 404 : Page Not Found
            return sendClearedCookies(404);
        }
    });
}

/**
 * 
 * @param req 
 * @param res 
 * @param userId 
 */
async function processCommentPost(req, res, userId) {
    let postData = '';

    req.on('data', /* node js readableStream instance */ (chunk) => {
        postData += chunk;
    });

    req.on("end", async () => {
        try {
            debugLog(6, 'Recieved data: ', postData);
            let commentData = JSON.parse(postData);

            let testThreadId = commentData.thread_id;
            let testComment = commentData.comment;
            if(testThreadId == 0) { testThreadId = null; } // * This statement is required as it is serverside conversion only.
            if(testComment == '') { throw 'comment is empty.'; }

            // TODO let sterileComment = sterlizeComment(testComment)

            debugLog(6, 'Attempting Comment Creation.');

            // TODO change to sterilize comment + threadId
            let isCommentCreated = await createComment(testComment, testThreadId, userId);
            debugLog(6, 'CommentCreated: ', isCommentCreated);

            // TODO add comment to the page.
            if(!isCommentCreated) {
                throw 'Comment failed to be created.'
            }

            // ? 200 : Ok
            return forwardContent(200, res, Buffer.from(isCommentCreated, 'utf-8'), 'text/plain');

        } catch (e) {
            debugLog(3, 'Comment Precess Failed: ', e, ' | ', e.stack);
            return declineRoute(400, res, 'CommentFailed.')
        }
    });
}

/**
 * 
 * @param res 
 * @param route 
 */
async function processThreadPage(res, route) {

    // * code to load threads in html page.  Currently not set to this method.
    // * To allow this method replace commenting.html and index.html with comment-thread-logic in .private/.old
    /* ( function sendJsonThreads() {
        let jsonThreadArr = {
            all_threads : await getAllThreadsPublic(),
        };

        // {
        // all_threads : [
        //     {
        //         comment_id : ##,
        //         content : "hello",
        //         thread_id : null,
        //         user : "nick",
        //         created : "2021-11-05T00:49:37.887Z"
        //     },
        //     { ...
        // ]

        forwardContent(200, res, Buffer.from(JSON.stringify(jsonThreadArr), 'utf-8'), 'application/json');

    })(); */

    let mapValueArr = fileLocationMap.get(route);
    let fileContents = await fs.readFile( mapValueArr[0] );

    return await ( async function sendFormatedThreadPage() {
        // ? 200 : Ok
        forwardContent(200, res, await exportCommentPage( fileContents.toString('utf-8') ), mapValueArr[1]);
    })();
}

// * For code heavy files, I find it best to place exports at the bottom.
export { checkGetRoute, checkPostRoute }