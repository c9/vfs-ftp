var getMime = require('simple-mime')("application/octet-stream");
var FTP = require("jsftp");
var Crypto = require("crypto");
var Stream = require('stream').Stream;

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
    return Crypto.createHash('md5').update("" + name + time + size).digest("hex");
}

// fsOptions.credentials - object containing port, host, user and password. All
// the properties are strings except for port, which is a number.
module.exports = function setup(fsOptions) {
    var ftpClient = new FTP(fsOptions.credentials);
    var handlers = {};

    return {
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

    function readfile(path, options, callback) {
        callback = once(callback);

        ftpClient.ls(path, function(err, result) {
            if (err || !result || result.length === 0)
                return callback("The file " + path + " could not be retrieved.");

            var stat = result[0]; // File information already parsed
            var meta = {
                mime: getMime(path),
                size: parseInt(stat.size, 10),
                etag: calcEtag(path + stat.size)
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
            if (err) return callback(err);

            var meta = {};
            if (options.head)
                return callback(null, meta);

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
            if (err) return error(err);

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
        ftpClient.raw.dele(path, callback);
    }

    function stat(path, options, callback) {
        ftpClient.ls(path, function(err, result) {
            if (err)
                return callback(new Error("The file " + path + " could not be retrieved."));

            var stat = result[0]; // File information already parsed
            var meta = {
                mime: getMime(path),
                size: parseInt(stat.size, 10),
                etag: calcEtag(path + stat.size),
                name: stat.name,
                path: path
            };

            callback(null, meta);
        });
    }

    function mkdir(path, options, callback) {
        ftpClient.raw.mkd(path, function(err) { callback(err, {}); });
    }

    function rmdir(path, options, callback) {
        ftpClient.raw.rmd(path, function (err) {
          if (err)
              return callback(err);

          return callback(null, {});
        });
    }

    function rename(path, options, callback) {
        ftpClient.rename(options.from, path, function(err) {
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
        ftpClient.getGetSocket(from, function(err, readable) {
            if (err)
                return callback(err);

            if (!readable)
                return callback(new Error("Could not retrieve readable stream for " + from));

            self.mkfile(to, { stream: readable }, callback);
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

    function resolve(path, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot resolve.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function symlink(path, options, callback) {
        callback(new Error("symlink: Not Implemented"));
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

    function extend(name, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot execFile.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function unextend(name, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot execFile.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }

    function use(name, options, callback) {
        var err = new Error("ENOTSUPPORTED: FTP cannot execFile.");
        err.code = "ENOTSUPPORTED";
        callback(err);
    }
};
