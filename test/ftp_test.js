/*global describe it beforeEach afterEach */
var exec = require("child_process").spawn;
var assert = require("assert");
var fs = require('fs');
var Ftp = require("jsftp");

var FTPCredentials = {
    host: "localhost",
    user: "user",
    port: 3334,
    pass: "12345"
};

describe("jsftp test suite", function() {
    var vfs, daemon;

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
            daemon.kill("SIGKILL");

        vfs.destroy();
        setTimeout(function() { next(); }, 100);
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
            assert(!err, err);
            Ftp._concatStream(null, meta.stream, function(err, data) {
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
        var realContents = fs.readFileSync("package.json");
        vfs.copy("package.json.bak", { from: "package.json" }, function(err, meta) {
            assert.ok(!err, err);
            vfs.readfile("package.json.bak", {}, function(err, meta) {
                assert.ok(!err);
                assert.equal(meta.size, fs.statSync("package.json").size);

                Ftp._concatStream(null, meta.stream, function(err, data) {
                    assert(!err);
                    assert.equal(realContents, data.toString());
                    next();
                });
            });
        });
    });

    it("vfs.copy should copy preserving the file integrity: to", function(next) {
        vfs.copy("package.json", { to: "package.json.bak" }, function(err, meta) {
            assert.ok(!err, err);
            vfs.readfile("package.json.bak", {}, function(err, meta) {
                assert.ok(!err, err);
                assert.equal(meta.size, fs.statSync("package.json").size);

                Ftp._concatStream(null, meta.stream, function(err, data) {
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
            assert.ok(err, err);
            // assert.equal(err.code, "ENOENT");
            next();
        });
    });
});
