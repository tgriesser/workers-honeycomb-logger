"use strict";
/** BSD 3-Clause License

Copyright (c) 2021, Cloudflare Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.hc = exports.wrapEventListener = void 0;
const config_1 = require("./config");
const promises_1 = require("./promises");
const logging_1 = require("./logging");
class LogWrapper {
    constructor(event, listener, config) {
        this.event = event;
        this.listener = listener;
        this.waitUntilUsed = false;
        this.config = config;
        this.tracer = new logging_1.RequestTracer(event.request, this.config);
        this.waitUntilSpan = this.tracer.startChildSpan('waitUntil', 'worker');
        this.settler = new promises_1.PromiseSettledCoordinator(() => {
            this.waitUntilSpan.finish();
            this.sendEvents();
        });
        this.setupWaitUntil();
        this.setUpRespondWith();
    }
    async sendEvents() {
        const excludes = this.waitUntilUsed ? [] : ['waitUntil'];
        await this.tracer.sendEvents(excludes);
        this.waitUntilResolve();
    }
    startWaitUntil() {
        this.waitUntilUsed = true;
        this.waitUntilSpan.start();
    }
    finishWaitUntil(error) {
        if (error) {
            this.tracer.addData({ exception: true, waitUtilException: error.toString() });
            this.waitUntilSpan.addData({ exception: error });
            if (error.stack)
                this.waitUntilSpan.addData({ stacktrace: error.stack });
        }
    }
    setupWaitUntil() {
        const waitUntilPromise = new Promise((resolve) => {
            this.waitUntilResolve = resolve;
        });
        this.event.waitUntil(waitUntilPromise);
        this.proxyWaitUntil();
    }
    proxyWaitUntil() {
        const logger = this;
        this.event.waitUntil = new Proxy(this.event.waitUntil, {
            apply: function (_target, _thisArg, argArray) {
                logger.startWaitUntil();
                const promise = Promise.resolve(argArray[0]);
                logger.settler.addPromise(promise);
                promise
                    .then(() => {
                    logger.finishWaitUntil();
                })
                    .catch((reason) => {
                    logger.finishWaitUntil(reason);
                });
            },
        });
    }
    setUpRespondWith() {
        this.proxyRespondWith();
        try {
            this.event.request.tracer = this.tracer;
            this.event.waitUntilTracer = this.waitUntilSpan;
            this.listener(this.event);
        }
        catch (err) {
            this.tracer.finishResponse(undefined, err);
        }
    }
    proxyRespondWith() {
        const logger = this;
        this.event.respondWith = new Proxy(this.event.respondWith, {
            apply: function (target, thisArg, argArray) {
                const responsePromise = Promise.resolve(argArray[0]);
                Reflect.apply(target, thisArg, argArray); //call event.respondWith with the wrapped promise
                const promise = new Promise((resolve, reject) => {
                    responsePromise
                        .then((response) => {
                        setTimeout(() => {
                            logger.tracer.finishResponse(response);
                            resolve(response);
                        }, 1);
                    })
                        .catch((reason) => {
                        setTimeout(() => {
                            logger.tracer.finishResponse(undefined, reason);
                            reject(reason);
                        }, 1);
                    });
                });
                logger.settler.addPromise(promise);
            },
        });
    }
}
function wrapEventListener(cfg, listener) {
    const config = (0, config_1.resolve)(cfg);
    return new Proxy(listener, {
        apply: function (_target, _thisArg, argArray) {
            const event = argArray[0];
            new LogWrapper(event, listener, config);
        },
    });
}
exports.wrapEventListener = wrapEventListener;
const hc = wrapEventListener;
exports.hc = hc;
