/*global describe it beforeEach afterEach */
var exec = require("child_process").spawn;
var assert = require("assert");
var fs = require('fs');

var daemon;
var FTPCredentials = {
    host: "localhost",
    user: "user",
    port: 3334,
    pass: "12345"
};

describe("jsftp test suite", function() {
    var vfs;
    beforeEach(function(next) {
        try {
            daemon = exec('python', ['node_modules/jsftp/test/basic_ftpd.py']);
        }
        catch(e) {
            console.log(
                "There was a problem trying to start the FTP service. " +
                "This could be because you don't have enough permissions " +
                "to run the FTP service on the given port. Please make sure that " +
                "you have python installed as well.\n\n" + e
            );
        }

        setTimeout(function() {
            vfs = require('vfs-lint')(require('../ftp')({
                credentials: FTPCredentials
            }));
            next();
        }, 200);
    });

    afterEach(function(next) {
        if (daemon)
            daemon.kill();

        setTimeout(function() {
            next();
        }, 200);
    });

    it("vfs.stat should return a valid 'stat' object", function(next) {
        vfs.stat("package.json", {}, function(err, meta) {
            assert.ok(!err, err);
            assert.equal(meta.mime, "application/json");
            assert.equal(meta.size, fs.statSync("package.json").size);
            assert.equal(meta.name, "package.json");
            assert.equal(meta.path, "package.json");
            next();
        });
    });

    it("vfs.readfile should return a valid 'stat' object with streaming file contents", function(next) {
        vfs.readfile("package.json", {}, function(err, meta) {
            concatStream(null, meta.stream, function(err, data) {
                assert(!err);
                var realContents = fs.readFileSync("package.json");
                assert.equal(realContents, data.toString());
                next();
            });

            assert.ok(!err);
            assert.equal(meta.mime, "application/json");
            assert.equal(meta.size, fs.statSync("package.json").size);
        });
    });

    it("vfs.readdir should return a valid 'stat' object with streaming file contents", function(next) {
        vfs.readdir("test", {}, function(err, meta) {
            assert.ok(!err);

            var entryArray = [];
            var fileList = fs.readdirSync("test");
            meta.stream.on("data", function(data) {
                entryArray.push(data);
            });

            meta.stream.on("end", function() {
                entryArray.forEach(function(file) {
                    assert.ok(fileList.indexOf(file.name) !== -1);
                });
                next();
            });
        });
    });

    it("vfs.readdir should return a valid 'stat' object with streaming file contents", function(next) {
        vfs.readdir("test", {}, function(err, meta) {
            assert.ok(!err);

            var entryArray = [];
            var fileList = fs.readdirSync("test");
            meta.stream.on("data", function(data) {
                entryArray.push(data);
            });

            meta.stream.on("end", function() {
                entryArray.forEach(function(file) {
                    assert.ok(fileList.indexOf(file.name) !== -1);
                });
                next();
            });
        });
    });

    it("vfs.copy should copy preserving the file integrity: from", function(next) {
        vfs.copy("package.json.bak", { from: "package.json" }, function(err, meta) {
            assert.ok(!err);
            vfs.readfile("package.json.bak", {}, function(err, meta) {
                assert.ok(!err);
                assert.equal(meta.size, fs.statSync("package.json").size);

                concatStream(null, meta.stream, function(err, data) {
                    assert(!err);
                    var realContents = fs.readFileSync("package.json");
                    assert.equal(realContents, data.toString());
                    next();
                });
            });
        });
    });

    it("vfs.copy should copy preserving the file integrity: to", function(next) {
        vfs.copy("package.json", { to: "package.json.bak" }, function(err, meta) {
            assert.ok(!err);
            vfs.readfile("package.json.bak", {}, function(err, meta) {
                assert.ok(!err);
                assert.equal(meta.size, fs.statSync("package.json").size);

                concatStream(null, meta.stream, function(err, data) {
                    assert(!err);
                    var realContents = fs.readFileSync("package.json");
                    assert.equal(realContents, data.toString());
                    vfs.rmfile("package.json.bak", {}, function(err, meta) {
                        assert(!err);
                        next();
                    });
                });
            });
        });
    });

    it("vfs.copy should fail copying a non-existing file", function(next) {
        vfs.copy("fake_file", { to: "package.json.bak" }, function(err, meta) {
            assert.ok(err);
            // assert.equal(err.code, "ENOENT");
            next();
        });
    });
});

function concat(bufs) {
    var buffer, length = 0, index = 0;

    if (!Array.isArray(bufs))
        bufs = Array.prototype.slice.call(arguments);

    for (var i=0, l=bufs.length; i<l; i++) {
        buffer = bufs[i];
        length += buffer.length;
    }

    buffer = new Buffer(length);

    bufs.forEach(function(buf, i) {
        buf.copy(buffer, index, 0, buf.length);
        index += buf.length;
    });

    return buffer;
}

function concatStream(err, stream, callback) {
    if (err) return callback(err);

    var pieces = [];
    stream.on("data", function(p) { pieces.push(p); });
    stream.on("end", function() { callback(null, concat(pieces)); });
    stream.on("error", function(e) { callback(e); });
}
