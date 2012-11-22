var getMime = require('simple-mime')("application/octet-stream");
var FTP = require("jsftp");
var Stream = require('stream').Stream;
var vm = require('vm');

function once(fn) {
    var done = false;
    return function () {
        if (done)
            return console.warn("Attempt to call callback more than once " + fn);

        done = true;
        return fn.apply(this, arguments);
    };
}

function calcEtag(name, time, size) {
    return '"' + time.toString(36) + "-" + size.toString(36) + '"';
}

// fsOptions.credentials - object containing port, host, user and password. All
// the properties are strings except for port, which is a number.
module.exports = function setup(fsOptions) {
    var ftpClient = new FTP(fsOptions.credentials);
    // Storage for extension APIs
    var apis = {};
    // Storage for event handlers
    var handlers = {};

    var vfs = {
        connect: connect,
        copy: copy,
        mkdir: mkdir,
        mkfile: mkfile,
        readdir: readdir,
        rename: rename,
        resolve: resolve,
        rmdir: rmdir,
        rmfile: rmfile,
        spawn: spawn,
        stat: stat,
        symlink: symlink,
        readfile: readfile,
        watch: watch,
        execFile: execFile,

        // Basic async event emitter style API
        on: on,
        off: off,
        emit: emit,

        // Extending the API
        extend: extend,
        unextend: unextend,
        use: use,

        destroy: destroy
    };

    // Consume all data in a readable stream and call callback with full buffer.
    function consumeStream(stream, callback) {
        var chunks = [];
        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
        function onData(chunk) {
            chunks.push(chunk);
        }
        function onEnd() {
            cleanup();
            callback(null, chunks.join(""));
        }
        function onError(err) {
            cleanup();
            callback(err);
        }
        function cleanup() {
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
        }
    }

    // node-style eval
    function evaluate(code) {
        var exports = {};
        var module = { exports: exports };
        vm.runInNewContext(code, {
            require: require,
            exports: exports,
            module: module,
            console: console,
            global: global,
            process: process,
            Buffer: Buffer,
            setTimeout: setTimeout,
            clearTimeout: clearTimeout,
            setInterval: setInterval,
            clearInterval: clearInterval
        }, "dynamic-" + Date.now().toString(36), true);
        return module.exports;
    }

    function readfile(path, options, callback) {
        callback = once(callback);

        ftpClient.ls(path, function(err, result) {
            if (err || !result || result.length === 0) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the file doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                var e = new Error("ENOENT - No such file or directory: " + path);
                e.code = "ENOENT";
                return callback(e);
            }
            var stat = result[0]; // File information already parsed
            var meta = {
                mime: getMime(path),
                size: parseInt(stat.size, 10),
                etag: calcEtag(path, stat.time, stat.size)
            };

            // ETag support
            if (options.etag === meta.etag) {
                meta.notModified = true;
                return callback(null, meta);
            }

            ftpClient.getGetSocket(path, function(err, readable) {
                if (err) return callback(err);

                meta.stream = readable;
                callback(null, meta);
            });
        });
    }

    function readdir(path, options, callback) {
        callback = once(callback);

        ftpClient.ls(path, function(err, list) {
            if (err || !list) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the file doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                var e = new Error("ENOENT - No such directory: " + path);
                e.code = "ENOENT";
                return callback(e);
            }

            var meta = {};
            if (options.head)
                return callback(null, meta);

            // There can be no proper ETag support since there is no way to
            // determine whether the directory contents have changed or not
            // without getting its listing, which defeats the purpose of caching.
            /*
            meta.etag = calcEtag(stat);
            if (options.etag === meta.etag) {
                meta.notModified = true;
                return callback(null, meta);
            }
            */

            var stream = new Stream();
            var paused;

            stream.readable = true;
            stream.pause = function () {
                if (paused === true) return;
                paused = true;
            };

            stream.resume = function () {
                if (paused === false) return;
                paused = false;
                getNext();
            };

            meta.stream = stream;
            callback(null, meta);

            var index = 0;
            stream.resume();
            function getNext() {
                if (index === list.length)
                    return done();

                var file = list[index++];
                var entry = {
                    name: file.name,
                    path: path,
                    href: "#",
                    mime: getMime(file.name),
                    size: parseInt(file.size, 10),
                    etag: calcEtag(file.name, file.time, file.size)
                };

                stream.emit("data", entry);

                if (!paused) {
                    getNext();
                }
            }
            function done() {
                stream.emit("end");
            }
        });
    }

    function mkfile(path, options, realCallback) {
        var meta = {};
        var called;
        var callback = function (err, meta) {
            if (called) {
                if (err) {
                    if (meta.stream)
                        meta.stream.emit("error", err);
                    else
                        console.error(err.stack);
                }
                else if (meta.stream) {
                    meta.stream.emit("saved");
                }
                return;
            }
            called = true;
            return realCallback.apply(this, arguments);
        };

        if (options.stream && !options.stream.readable) {
            return callback(new TypeError("options.stream must be readable."));
        }

        // Pause the input for now since we're not ready to write quite yet
        var readable = options.stream;
        function error(err) {
            if (readable && readable.destroy) {
                readable.destroy();
            }
            if (err) return callback(err);
        }

        ftpClient.getPutSocket(path, function(err, socket) {
            if (err) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the path doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                var e = new Error("ENOENT - No such file or directory: " + path);
                e.code = "ENOENT";
                return error(e);
            }

            if (!socket || !socket.writable) {
                callback(new Error("Could not get socket for '" + path + "'."));
            }

            meta.stream = socket;
            socket.on("close", function () { callback(null, meta); });
            socket.on("error", error);

            if (readable) { // An input stream was provided
                readable.on("error", error);
                readable.pipe(socket);

                if (readable.resume)
                    readable.resume();
            }
        });
    }

    function rmfile(path, options, callback) {
        ftpClient.raw.dele(path, function (err) {
            if (err) {
                err.code = "ENOENT";
                return callback(err);
            }
            return callback(err, {});
        });
    }

    function stat(path, options, callback) {
        ftpClient.ls(path, function(err, result) {
            if (err) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the file doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                var e = new Error("ENOENT - No such file or directory: " + path);
                e.code = "ENOENT";
                return callback(e);
            }

            var stat = result[0]; // File information already parsed
            var meta = {
                mime: getMime(path),
                size: parseInt(stat.size, 10),
                etag: calcEtag(path, stat.time, stat.size),
                name: stat.name,
                path: path
            };

            callback(null, meta);
        });
    }

    function mkdir(path, options, callback) {
        ftpClient.raw.mkd(path, function(err) {
            if (err && err.code === 550) {
                var e = new Error("EEXIST - Error creating directory: " + path +
                    "FTP Error: " + err.message);
                e.code = "EEXIST";
                return callback(e);
            }
            return callback(err, {});
        });
    }

    function rmdir(path, options, callback) {
        ftpClient.raw.rmd(path, function (err) {
            if (err) {
                err.code = "ENOENT";
                return callback(err);
            }
            return callback(err, {});
        });
    }

    function rename(path, options, callback) {
        var from, to;
        if (options.from) {
            from = options.from; to = path;
        }
        else if (options.to) {
            from = path; to = options.to;
        }
        else {
            return callback(new Error("Must specify either options.from or options.to"));
        }

        ftpClient.rename(from, to, function(err) {
            if (err) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the file doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                var e = new Error("ENOENT - No such file or directory: " + path);
                e.code = "ENOENT";
                return callback(e);
            }
            callback(err, {});
        });
    }

    function copy(path, options, callback) {
        // We don't want to calll the callback twice in any situation
        callback = once(callback);

        var from, to;
        if (options.from) {
            from = options.from; to = path;
        }
        else if (options.to) {
            from = path; to = options.to;
        }
        else {
            return callback(new Error("Must specify either options.from or options.to"));
        }

        var self = this;
        this.readfile(from, {}, function(err, meta) {
            if (err) return callback(err);
            self.mkfile(to, { stream: meta.stream }, callback);
        });
    }

    function on(name, handler, callback) {
        if (!handlers[name])
            handlers[name] = [];

        handlers[name].push(handler);
        callback && callback();
    }

    function off(name, handler, callback) {
        var list = handlers[name];
        if (list) {
            var index = list.indexOf(handler);
            if (index >= 0) {
                list.splice(index, 1);
            }
        }
        callback && callback();
    }

    function emit(name, value, callback) {
        var list = handlers[name];
        if (list) {
            for (var i = 0, l = list.length; i < l; i++) {
                list[i](value);
            }
        }
        callback && callback();
    }

    function destroy() {
        if (ftpClient) {
            ftpClient.destroy();
            ftpClient = null;
        }
    }

    function extend(name, options, callback) {

        var meta = {};
        // Pull from cache if it's already loaded.
        if (!options.redefine && apis.hasOwnProperty(name)) {
            var err = new Error("EEXIST: Extension API already defined for " + name);
            err.code = "EEXIST";
            return callback(err);
        }

        var fn;

        // The user can pass in a path to a file to require
        if (options.file) {
            try { fn = require(options.file); }
            catch (err) { return callback(err); }
            fn(vfs, onEvaluate);
        }

        // User can pass in code as a pre-buffered string
        else if (options.code) {
            try { fn = evaluate(options.code); }
            catch (err) { return callback(err); }
            fn(vfs, onEvaluate);
        }

        // Or they can provide a readable stream
        else if (options.stream) {
            consumeStream(options.stream, function (err, code) {
                if (err) return callback(err);
                var fn;
                try {
                    fn = evaluate(code);
                } catch(err) {
                    return callback(err);
                }
                fn(vfs, onEvaluate);
            });
        }

        else {
            return callback(new Error("must provide `file`, `code`, or `stream` when cache is empty for " + name));
        }

        function onEvaluate(err, exports) {
            if (err) {
                return callback(err);
            }
            exports.names = Object.keys(exports);
            exports.name = name;
            apis[name] = exports;
            meta.api = exports;
            callback(null, meta);
        }

    }

    function unextend(name, options, callback) {
        delete apis[name];
        callback(null, {});
    }

    function use(name, options, callback) {
        var api = apis[name];
        if (!api) {
            var err = new Error("ENOENT: There is no API extension named " + name);
            err.code = "ENOENT";
            return callback(err);
        }
        callback(null, {api:api});
    }

    function resolve(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot resolve.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function symlink(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot symlink.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function spawn(executablePath, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot spawn.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function connect(port, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot connect.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function watch(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot watch.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function execFile(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot execFile.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    return vfs;
};
