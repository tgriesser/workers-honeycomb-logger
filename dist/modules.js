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
exports.wrapDurableObject = exports.wrapModule = void 0;
const config_1 = require("./config");
const logging_1 = require("./logging");
function cacheTraceId(trace_id) {
    const headers = {
        'cache-control': 'max-age=90',
    };
    caches.default.put(`https://fake-trace-cache.com/${trace_id}`, new Response('Ok', { headers }));
}
async function isRealTraceRequest(trace_id) {
    const url = `https://fake-trace-cache.com/${trace_id}`;
    const response = await caches.default.match(url);
    const found = !!response;
    if (found) {
        caches.default.delete(url);
    }
    return found;
}
async function sendEventToHoneycomb(request, config) {
    const event = await request.json();
    if (await isRealTraceRequest(event.trace.trace_id)) {
        const url = `https://api.honeycomb.io/1/events/${encodeURIComponent(config.dataset)}`;
        const params = {
            method: 'POST',
            body: JSON.stringify(event),
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Honeycomb-Team': config.apiKey,
                'X-Honeycomb-Event-Time': event.timestamp || event.Timestamp,
            },
        };
        return fetch(url, params);
    }
    else {
        return new Response(`No trace found with ID: ${event.trace.trace_id}`);
    }
}
function proxyFetch(obj, tracer, name) {
    obj.fetch = new Proxy(obj.fetch, {
        apply: (target, thisArg, argArray) => {
            const info = argArray[0];
            const input = argArray[1];
            const request = new Request(info, input);
            const childSpan = tracer.startChildSpan(request.url, name);
            const traceHeaders = childSpan.eventMeta.trace.getHeaders();
            request.headers.set('traceparent', traceHeaders.traceparent);
            if (traceHeaders.tracestate)
                request.headers.set('tracestate', traceHeaders.tracestate);
            childSpan.addRequest(request);
            const promise = Reflect.apply(target, thisArg, [request]);
            promise
                .then((response) => {
                childSpan.addResponse(response);
                childSpan.finish();
            })
                .catch((reason) => {
                childSpan.addData({ exception: reason });
                childSpan.finish();
            });
            return promise;
        },
    });
    return obj;
}
function proxyGet(fn, tracer, do_name) {
    return new Proxy(fn, {
        apply: (target, thisArg, argArray) => {
            const obj = Reflect.apply(target, thisArg, argArray);
            return proxyFetch(obj, tracer, do_name);
        },
    });
}
function proxyNS(dns, tracer, do_name) {
    return new Proxy(dns, {
        get: (target, prop, receiver) => {
            const value = Reflect.get(target, prop, receiver);
            if (prop === 'get') {
                return proxyGet(value, tracer, do_name).bind(dns);
            }
            else {
                return value ? value.bind(dns) : undefined;
            }
        },
    });
}
function proxyEnv(env, tracer) {
    return new Proxy(env, {
        get: (target, prop, receiver) => {
            const value = Reflect.get(target, prop, receiver);
            if (value && value.idFromName) {
                return proxyNS(value, tracer, prop.toString());
            }
            else if (value && value.fetch) {
                return proxyFetch(value, tracer, prop.toString());
            }
            else {
                return value;
            }
        },
    });
}
function workerProxy(config, mod) {
    return {
        fetch: new Proxy(mod.fetch, {
            apply: (target, thisArg, argArray) => {
                const request = argArray[0];
                if (new URL(request.url).pathname === '/_send_honeycomb_event') {
                    return sendEventToHoneycomb(request, config);
                }
                const tracer = new logging_1.RequestTracer(request, config);
                if (tracer.eventMeta.trace.parent_id) {
                    //this is part of a distributed trace
                    cacheTraceId(tracer.eventMeta.trace.trace_id);
                }
                request.tracer = tracer;
                const env = argArray[1];
                argArray[1] = proxyEnv(env, tracer);
                config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey;
                config.dataset = env.HONEYCOMB_DATASET || config.dataset;
                if (!config.apiKey || !config.dataset) {
                    console.error(new Error('Need both HONEYCOMB_API_KEY and HONEYCOMB_DATASET to be configured. Skipping trace.'));
                    return Reflect.apply(target, thisArg, argArray);
                }
                const ctx = argArray[2];
                //TODO: proxy ctx.waitUntil
                try {
                    const result = Reflect.apply(target, thisArg, argArray);
                    if (result instanceof Response) {
                        tracer.finishResponse(result);
                        ctx.waitUntil(tracer.sendEvents());
                        return Promise.resolve(result);
                    }
                    else {
                        result.then((response) => {
                            tracer.finishResponse(response);
                            ctx.waitUntil(tracer.sendEvents());
                            return response;
                        });
                        result.catch((err) => {
                            tracer.finishResponse(undefined, err);
                            ctx.waitUntil(tracer.sendEvents());
                            throw err;
                        });
                        return result;
                    }
                }
                catch (err) {
                    tracer.finishResponse(undefined, err);
                    ctx.waitUntil(tracer.sendEvents());
                    throw err;
                }
            },
        }),
    };
}
function proxyObjFetch(config, orig_fetch, do_name) {
    return new Proxy(orig_fetch, {
        apply: (target, thisArg, argArray) => {
            const request = argArray[0];
            const tracer = new logging_1.RequestTracer(request, config);
            const env = argArray[1];
            argArray[1] = proxyEnv(env, tracer);
            config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey;
            config.dataset = env.HONEYCOMB_DATASET || config.dataset;
            if (!config.apiKey || !config.dataset) {
                console.error(new Error('Need both HONEYCOMB_API_KEY and HONEYCOMB_DATASET to be configured. Skipping trace.'));
                return Reflect.apply(target, thisArg, argArray);
            }
            tracer.eventMeta.service.name = do_name;
            tracer.eventMeta.name = new URL(request.url).pathname;
            request.tracer = tracer;
            try {
                const result = Reflect.apply(target, thisArg, argArray);
                if (result instanceof Response) {
                    tracer.finishResponse(result);
                    tracer.sendEvents();
                    return Promise.resolve(result);
                }
                else {
                    result.then((response) => {
                        tracer.finishResponse(response);
                        tracer.sendEvents();
                        return response;
                    });
                    result.catch((err) => {
                        tracer.finishResponse(undefined, err);
                        tracer.sendEvents();
                        throw err;
                    });
                    return result;
                }
            }
            catch (err) {
                tracer.finishResponse(undefined, err);
                tracer.sendEvents();
                throw err;
            }
        },
    });
}
function wrapModule(cfg, mod) {
    const config = (0, config_1.resolve)(cfg);
    return workerProxy(config, mod);
}
exports.wrapModule = wrapModule;
function wrapDurableObject(cfg, do_class) {
    const config = (0, config_1.resolve)(cfg);
    config.acceptTraceContext = true;
    return new Proxy(do_class, {
        construct: (target, argArray) => {
            const obj = new target(...argArray);
            obj.fetch = proxyObjFetch(config, obj.fetch, do_class.name);
            return obj;
        },
    });
}
exports.wrapDurableObject = wrapDurableObject;
