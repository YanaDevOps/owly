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

/* global setPassword */

document.getElementById('passwordform').onsubmit = async function(e) {
    e.preventDefault();

    const parms = new URLSearchParams(window.location.search);
    const group = parms.get('group');
    if (!group) {
        displayError("Couldn't determine group");
        return;
    }
    const user = parms.get('username');
    if (!user) {
        displayError("Couldn't determine username");
        return;
    }

    const old = document.getElementById('old').value;
    const new1 = document.getElementById('new1').value;
    const new2 = document.getElementById('new2').value;
    if (new1 !== new2) {
        displayError("Passwords don't match.");
        return;
    }

    try {
        await setPassword(group, user, false, new1, old);
        document.getElementById('old').value = '';
        document.getElementById('new1').value = '';
        document.getElementById('new2').value = '';
        displayError(null);
        document.getElementById('message').textContent =
            'Password successfully changed.';
    } catch (e) {
        displayError(e.toString());
    }
};

function displayError(message) {
    document.getElementById('errormessage').textContent = (message || '');
}
