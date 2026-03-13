// Copyright (c) 2026 yanix.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

let imageSegmenter;
let usesCPU = false; // Track if we fell back to CPU mode

// MediaPipe patches canvas with getContextSafariWebGL2Fixed as a Safari
// WebGL2 workaround. In a worker, OffscreenCanvas and sometimes HTMLCanvasElement
// don't get this patch, so the WASM code crashes. Add a fallback that delegates to getContext.
// IMPORTANT: These patches must come BEFORE the document shim below, since MediaPipe
// may call document.createElement('canvas') during module import.

// Patch OffscreenCanvas if available
if (typeof OffscreenCanvas !== 'undefined' &&
   !OffscreenCanvas.prototype.getContextSafariWebGL2Fixed) {
    OffscreenCanvas.prototype.getContextSafariWebGL2Fixed =
        function(type, attrs) {
            return this.getContext(type, attrs);
        };
}

// Also patch HTMLCanvasElement if it exists in this worker context
if (typeof HTMLCanvasElement !== 'undefined' &&
   !HTMLCanvasElement.prototype.getContextSafariWebGL2Fixed) {
    HTMLCanvasElement.prototype.getContextSafariWebGL2Fixed =
        function(type, attrs) {
            return this.getContext(type, attrs);
        };
}

// MediaPipe's vision_bundle.mjs accesses 'document' during module init.
// Workers don't have 'document', so provide a minimal shim to prevent
// ReferenceError on browsers like Chrome on iOS.
if (typeof document === 'undefined') {
    // Check if OffscreenCanvas is available for creating functional canvas elements
    const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

    // Canvas factory that creates elements with working getContext methods
    const createCanvasElement = function() {
        if (hasOffscreenCanvas) {
            // Use OffscreenCanvas which supports getContext
            const canvas = new OffscreenCanvas(300, 150);

            // Patch getContext to try multiple WebGL context types with permissive attributes
            const originalGetContext = canvas.getContext.bind(canvas);
            canvas.getContext = function(type, attrs) {
                // For WebGL contexts, try with attributes that work better on Linux
                if (type === 'webgl2' || type === 'webgl') {
                    const webglAttrs = {
                        alpha: true,
                        antialias: false,
                        depth: false,
                        stencil: false,
                        premultipliedAlpha: true,
                        preserveDrawingBuffer: false,
                        powerPreference: 'default',
                        failIfMajorPerformanceCaveat: false,
                        ...attrs,
                    };
                    const ctx = originalGetContext(type, webglAttrs);
                    if (ctx) return ctx;

                    // If webgl2 failed, try webgl1
                    if (type === 'webgl2') {
                        console.warn('[Canvas] WebGL2 failed, trying WebGL1');
                        return originalGetContext('webgl', webglAttrs);
                    }
                }
                return originalGetContext(type, attrs);
            };

            // Ensure getContextSafariWebGL2Fixed is available
            if (!canvas.getContextSafariWebGL2Fixed) {
                canvas.getContextSafariWebGL2Fixed = function(type, attrs) {
                    return this.getContext(type, attrs);
                };
            }
            return canvas;
        } else {
            // Fallback: return a minimal canvas-like object with getContext stub
            // This won't actually work for WebGL, but prevents immediate crashes
            return {
                setAttribute: function() {},
                style: {},
                getContext: function() {
                    return null;
                },
                getContextSafariWebGL2Fixed: function() {
                    return null;
                },
                width: 300,
                height: 150,
            };
        }
    };

    self.document = {
        createElement: function(tag) {
            if (tag === 'canvas') {
                return createCanvasElement();
            }
            return {
                setAttribute: function() {},
                style: {},
            };
        },
        createElementNS: function(ns, tag) {
            if (tag === 'canvas') {
                return createCanvasElement();
            }
            return {
                setAttribute: function() {},
                style: {},
            };
        },
        head: { appendChild: function() {} },
        body: { appendChild: function() {} },
    };
}

// Test if WebGL is available in this worker context
function testWebGLSupport() {
    try {
        if (typeof OffscreenCanvas === 'undefined') {
            console.warn('[WebGL Test] OffscreenCanvas not available');
            return false;
        }

        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

        if (!gl) {
            console.warn('[WebGL Test] Failed to get WebGL context from OffscreenCanvas');
            return false;
        }

        console.log('[WebGL Test] WebGL context created successfully:', {
            version: gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1',
            vendor: gl.getParameter(gl.VENDOR),
            renderer: gl.getParameter(gl.RENDERER),
        });

        return true;
    } catch (e) {
        console.error('[WebGL Test] Error testing WebGL support:', e);
        return false;
    }
}

async function loadImageSegmenter(model) {
    // Test WebGL availability first
    const hasWebGL = testWebGLSupport();
    if (!hasWebGL) {
        throw new Error('WebGL is not available in this worker context. Background blur/replace requires WebGL support. This may be due to:\n' +
            '1. GPU blacklisting in Chrome (chrome://gpu)\n' +
            '2. Disabled hardware acceleration\n' +
            '3. Linux-specific WebGL limitations in workers\n\n' +
            'Try enabling hardware acceleration in chrome://settings or use a different browser.');
    }

    const module = await import('/third-party/tasks-vision/vision_bundle.mjs');
    const vision = await module.FilesetResolver.forVisionTasks(
        "/third-party/tasks-vision/wasm",
    );

    const options = {
        baseOptions: {
            modelAssetPath: model,
        },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'VIDEO',
    };

    // Try GPU first, fall back to CPU if it fails
    try {
        console.log('[ImageSegmenter] Attempting GPU initialization...');
        options.baseOptions.delegate = 'GPU';
        const segmenter = await module.ImageSegmenter.createFromOptions(vision, options);
        console.log('[ImageSegmenter] Successfully initialized with GPU acceleration');
        usesCPU = false;
        return segmenter;
    } catch (gpuError) {
        // Check if this is a WebGL context creation error
        const isWebGLError = gpuError.message &&
            (gpuError.message.includes('emscripten_webgl_create_context') ||
             gpuError.message.includes('kGpuService') ||
             gpuError.message.includes('WebGL'));

        if (isWebGLError) {
            console.warn('[ImageSegmenter] GPU initialization failed, falling back to CPU:', gpuError.message);
            try {
                options.baseOptions.delegate = 'CPU';
                const segmenter = await module.ImageSegmenter.createFromOptions(vision, options);
                console.log('[ImageSegmenter] Successfully initialized with CPU mode');
                usesCPU = true;
                return segmenter;
            } catch (cpuError) {
                console.error('[ImageSegmenter] CPU initialization also failed:', cpuError);

                // Provide helpful error message
                const errorMsg = 'MediaPipe initialization failed. This is likely because:\n' +
                    '1. WebGL is blacklisted for workers on your GPU (check chrome://gpu)\n' +
                    '2. Hardware acceleration is disabled\n' +
                    '3. Your Linux GPU drivers have limited WebGL support\n\n' +
                    'Workaround: Try enabling hardware acceleration in chrome://settings, ' +
                    'or override GPU blacklist with --ignore-gpu-blacklist flag, ' +
                    'or use Firefox which may have better WebGL worker support.';

                throw new Error(errorMsg);
            }
        } else {
            // Not a WebGL error, re-throw the original error
            throw gpuError;
        }
    }
}

async function foregroundMask(bitmap, timestamp) {
    if (!(bitmap instanceof ImageBitmap))
        throw new Error('Bad type for worker data');

    try {
        const width = bitmap.width;
        const height = bitmap.height;
        const p = new Promise((resolve, _reject) =>
            imageSegmenter.segmentForVideo(
                bitmap, timestamp,
                result => resolve(result),
            ));
        const result = await p;
        /** @type{Uint8Array} */
        const mask = result.categoryMask.getAsUint8Array();
        const id = new ImageData(width, height);
        for (let i = 0; i < mask.length; i++)
            id.data[4 * i + 3] = mask[i];
        result.close();

        const ib = await createImageBitmap(id);
        return {
            bitmap: bitmap,
            mask: ib,
        };
    } catch (e) {
        bitmap.close();
        throw e;
    }
}

onmessage = async e => {
    const data = e.data || {};
    const requestId = data._requestId;
    try {
        if (data.model) {
            if (imageSegmenter)
                throw new Error("image segmenter already initialised");
            imageSegmenter = await loadImageSegmenter(data.model);
            if (!imageSegmenter)
                throw new Error("loadImageSegmenter returned null");
            postMessage({
                _requestId: requestId,
                success: true,
                usesCPU: usesCPU,
            });
        } else if (data.bitmap) {
            if (!imageSegmenter)
                throw new Error("image segmenter not initialised");
            const mask = await foregroundMask(data.bitmap, data.timestamp);
            postMessage({
                _requestId: requestId,
                bitmap: mask.bitmap,
                mask: mask.mask,
            }, [mask.bitmap, mask.mask]);
        } else {
            throw new Error("unexpected message type");
        }
    } catch (e) {
        postMessage({
            _requestId: requestId,
            error: {
                name: e && e.name ? e.name : 'Error',
                message: e && e.message ? e.message : String(e),
            },
        });
    }
};
