var getMime = require('simple-mime')("application/octet-stream");
var FTP = require("jsftp");
var Stream = require('stream').Stream;
var vm = require('vm');
var Path = require("path");

function once(fn) {
    var done = false;
    return function () {
        if (done)
            return console.warn("Attempt to call callback more than once " + fn);

        done = true;
        return fn.apply(this, arguments);
    };
}

function calcEtag(time, size) {
    var etag;
    if (time && size)
        etag = '"' + time.toString(36) + "-" + size.toString(36) + '"';
    else
        etag = '"' + Date.now().toString(36) + "-" + parseInt(Math.random() * 1000).toString(36) + '"'

    return etag
}

// fsOptions.credentials - object containing port, host, user and password. All
// the properties are strings except for port, which is a number.
module.exports = function setup(cfg) {
    var ftpClient = new FTP(cfg);

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

        this.stat(path, options, function(err, stat) {
            if (err) return callback(err);
            if (stat.mime === "inode/directory") {
                var e = new Error("EISDIR: Requested resource is a directory");
                e.code = "EISDIR";
                return callback(e);
            }

            // ETag support
            if (options.etag === stat.etag) {
                stat.notModified = true;
                return callback(null, stat);
            }

            ftpClient.getGetSocket(path, function(err, readable) {
                if (err) return callback(err);

                stat.stream = readable;
                stat.stream.resume();
                callback(null, stat);
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
                if (index >= (list.length-1))
                    return done();

                var file = list[index++];
                
		var entry = {
			name: file.name,
			path: path,
			href: "#",
			mime: (file.type === 1) ? "inode/directory" : getMime(file.name),
			size: parseInt(file.size, 10),
			etag: calcEtag(file.time, file.size)
		};
		stream.emit("data", entry);

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

        if (readable && readable.pause)
            readable.pause();

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
            else {
                socket.write("", "utf8", function () { callback(null, meta); });
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
        if (path === "/") {
            return callback(null, {
                mime: "inode/directory",
                size: 0,
                name: "/",
                path: path
            });
        }

        var baseName = Path.basename(path).replace("/", "");
        var parentDir = Path.resolve(path + "/..");
        var e = new Error("ENOENT - No such file or directory: " + path);
        e.code = "ENOENT";

        ftpClient.ls(parentDir, function(err, result) {
            if (err) {
                // Officially only ftp codes 450, 550 and 451 mean strictly that
                // the file doesn't exist, but let's assume that file doesn't exist
                // anyway if we reached this point
                return callback(e);
            }

            var file;
            for (var i = 0; i < ( result.length - 1 ); i++) {
                var stat = result[i];
                if (stat.name === baseName) {
                    file = stat;
                    break;
                }
            }

            if (file) {
                var mime;
                if (file.type === 1) // Is it a directory?
                    mime = "inode/directory";
                else if (file.type === 0)
                    mime = getMime(path);

                var meta = {
                    mime: mime,
                    size: parseInt(file.size, 10),
                    etag: calcEtag(file.time, file.size),
                    name: file.name,
                    path: path
                };

                callback(null, meta);
            }
            else {
                callback(e);
            }
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
            self.mkfile(to, meta, callback);
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

    function extend(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot extend.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function unextend(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot unextend.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function use(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot use.");
        err.code = "ENOTSUPPORTED";
        callback(err);
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
