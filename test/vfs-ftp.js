/*global describe it beforeEach afterEach */
var libpath = process.env['VFS_FTP_COV'] ? '../lib-cov' : '../lib';
var exec = require("child_process").spawn;
var assert = require("assert");
var fs = require('fs');
var Ftp = require("jsftp");
var expect = require('chai').expect;

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
        catch (e) {
            console.log("There was a problem trying to start the FTP service. " + "This could be because you don't have enough permissions " + "to run the FTP service on the given port. Please make sure that " + "you have python installed as well.\n\n" + e);
        }

        setTimeout(function() {
            vfs = require('vfs-lint')(require(libpath + '/ftp')({
                credentials: FTPCredentials
            }));
            next();
        }, 200);
    });

    afterEach(function(next) {
        if (daemon) daemon.kill("SIGKILL");

        vfs.destroy();
        setTimeout(function() {
            next();
        }, 100);
    });

    describe("readFile()", function() {
        it("should return a valid 'stat' object with streaming file contents", function(next) {
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

        it("should return an error for unexisting files", function(next) {
            vfs.readfile("package.json-fake", {}, function(err, meta) {
                assert(err);
                assert.equal(err.code, "ENOENT");
                next();
            });
        });

        it("should properly handle etags", function(next) {
            vfs.readfile("package.json", {}, function(err, meta) {
                assert(!err);
                assert(meta.etag);
                vfs.readfile("package.json", {
                    etag: meta.etag
                }, function(err, meta2) {
                    assert(!err);
                    assert.equal(meta2.notModified, true);
                    next();
                });
            });
        });
    });

    describe("readdir()", function() {
        var fileList = fs.readdirSync("test");

        it("should return an array of valid file 'stat' object with streaming", function(next) {
            vfs.readdir("test", {}, function(err, meta) {
                assert.ok(!err);

                var entryArray = [];
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

        it("should properly handle pause() and resume()", function(next) {
            vfs.readdir("test", {}, function(err, meta) {
                assert.ok(!err);

                meta.stream.pause();

                var entryArray = [];
                var fileList = fs.readdirSync("test");
                setTimeout(function() {
                    meta.stream.resume();
                }, 1000);

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

        it("should return an error for non-existing dirs", function(next) {
            vfs.readdir("test-fake", {}, function(err, meta) {
                assert.ok(err);
                assert.equal(err.code, "ENOENT");
                next();
            });
        });

        it("should return an empty meta on a head request", function(next) {
            vfs.readdir("test", {
                head: true
            }, function(err, meta) {
                assert.ok(!err);
                assert.equal(Object.keys(meta).length, 0);
                next();
            });
        });
    });

    describe("copy()", function() {
        it("vfs.copy should copy preserving the file integrity: from", function(next) {
            var realContents = fs.readFileSync("package.json", "utf8");
            var target = "package.json.bak";
            vfs.copy(target, {
                from: "package.json"
            }, function(err, meta) {
                assert.ok(!err, err);
                assert.ok(fs.existsSync(target));
                assert.equal(fs.readFileSync(target, "utf8"), realContents);
                fs.unlinkSync(target);
                next();
            });
        });

        it("vfs.copy should copy preserving the file integrity: to", function(next) {
            var realContents = fs.readFileSync("package.json", "utf8");
            var target = "package.json.bak";

            vfs.copy("package.json", {
                to: target
            }, function(err, meta) {
                assert.ok(!err, err);
                assert.ok(fs.existsSync(target));
                assert.equal(fs.readFileSync(target, "utf8"), realContents);
                fs.unlinkSync(target);
                next();
            });
        });

        it("vfs.copy should fail copying from a non-existing source", function(next) {
            vfs.copy("fake_file", {
                to: "package.json.bak"
            }, function(err, meta) {
                assert.ok(err, err);
                assert.equal(err.code, "ENOENT");
                next();
            });
        });

        it("vfs.copy should fail copying to a non-existing destination", function(next) {
            vfs.copy("package.json", {
                to: "fake/path/package.json.bak"
            }, function(err, meta) {
                assert.ok(err, err);
                assert.equal(err.code, "ENOENT");
                next();
            });
        });
    });

    describe('vfs.stat()', function() {
        var realStat = fs.statSync("package.json");
        it('should return stat info for the text file', function(next) {
            vfs.stat("/package.json", {}, function(err, stat) {
                assert(!err);
                assert.equal(stat.name, "package.json");
                assert.equal(stat.size, realStat.size);
                assert.equal(stat.mime, "application/json");
                next();
            });
        });

        it("should error with ENOENT when the file doesn't exist", function(next) {
            vfs.stat("/badfile.json", {}, function(err, stat) {
                assert.equal(err.code, "ENOENT");
                next();
            });
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
    });

    describe('mkdir()', function() {
        it("should create a directory", function(next) {
            var vpath = "newdir";
            // Make sure it doesn't exist yet
            assert.ok(!fs.existsSync(vpath));
            vfs.mkdir(vpath, {}, function(err, meta) {
                if (err) {
                    if (fs.existsSync(vpath)) fs.rmdirSync(vpath);
                    return next(err);
                }
                assert.ok(fs.existsSync(vpath));
                fs.rmdirSync(vpath);
                next();
            });
        });
        it("should error with EEXIST when the directory already exists", function(next) {
            vfs.mkdir("/test", {}, function(err, meta) {
                assert.equal(err.code, "EEXIST");
                next();
            });
        });
        it("should error with EEXIST when a file already exists at the path", function(next) {
            vfs.mkdir("/package.json", {}, function(err, meta) {
                assert.equal(err.code, "EEXIST");
                next();
            });
        });
    });

    describe('vfs.rename()', function() {
        it("should rename a file using options.to", function(done) {
            var before = "start.txt";
            var after = "end.txt";
            var text = "Move me please\n";

            fs.writeFileSync(before, text);
            expect(fs.existsSync(before)).ok;
            expect(fs.existsSync(after)).not.ok;

            vfs.rename(before, {
                to: after
            }, function(err, meta) {
                if (err) throw err;
                expect(fs.existsSync(before)).not.ok;
                expect(fs.existsSync(after)).ok;
                expect(fs.readFileSync(after, "utf8")).equal(text);
                fs.unlinkSync(after);
                done();
            });
        });

        it("should rename a file using options.from", function(done) {
            var before = "start.txt";
            var after = "end.txt";
            var text = "Move me please\n";

            fs.writeFileSync(before, text);
            expect(fs.existsSync(before)).ok;
            expect(fs.existsSync(after)).not.ok;

            vfs.rename(after, {
                from: before
            }, function(err, meta) {
                if (err) throw err;
                expect(fs.existsSync(before)).not.ok;
                expect(fs.existsSync(after)).ok;
                expect(fs.readFileSync(after, "utf8")).equal(text);
                fs.unlinkSync(after);
                done();
            });
        });

        it("should error with ENOENT if the source doesn't exist", function(done) {
            vfs.rename("notexist", {
                to: "newname"
            }, function(err, meta) {
                expect(err).property("code").equal("ENOENT");
                done();
            });
        });
    });

    describe('rmfile()', function() {
        it("should delete a file", function(next) {
            var vpath = "deleteme.txt";
            fs.writeFileSync(vpath, "DELETE ME!\n");
            assert.ok(fs.existsSync(vpath));
            vfs.rmfile(vpath, {}, function(err, meta) {
                if (err) throw err;
                assert(!fs.existsSync(vpath));
                next();
            });
        });

        it("should error with ENOENT if the file doesn't exist", function(next) {
            var vpath = "/badname.txt";
            assert.ok(!fs.existsSync(vpath));
            vfs.rmfile(vpath, {}, function(err, meta) {
                assert.equal(err.code, "ENOENT");
                next();
            });
        });

        /*
        it("should error with EISDIR if the path is a directory", function(next) {
            var vpath = "/dir";
            assert.ok(fs.existsSync(vpath));
            vfs.rmfile(vpath, {}, function(err, meta) {
                assert.equal(err.code, "EISDIR");
                next();
            });
        });
        */
    });

    describe('rmdir()', function() {
        it("should delete a directory", function(next) {
            var vpath = "newdir";
            fs.mkdirSync(vpath);
            assert(fs.existsSync(vpath));
            vfs.rmdir(vpath, {}, function(err, meta) {
                assert(!err);
                assert(!fs.existsSync(vpath));
                next();
            });
        });

        it("should error with ENOENT if the directory doesn't exist", function(next) {
            var vpath = "/baddir";
            assert(!fs.existsSync(vpath));
            vfs.rmdir(vpath, {}, function(err, meta) {
                assert.equal(err.code, "ENOENT");
                next();
            });
        });

        /*
        it("should error with ENOTDIR if the path is a file", function(next) {
            var vpath = "package.json";
            assert(fs.existsSync(vpath));
            vfs.rmdir(vpath, {}, function(err, meta) {
                assert.equal(err.code, "ENOTDIR");
                next();
            });
        });

        it("should do recursive deletes if options.recursive is set", function(next) {
            fs.mkdirSync(base + "/foo");
            fs.writeFileSync(base + "/foo/bar.txt", "Hello");
            expect(fs.existsSync(base + "/foo")).ok;
            expect(fs.existsSync(base + "/foo/bar.txt")).ok;
            vfs.rmdir("/foo", {
                recursive: true
            }, function(err, meta) {
                if (err) throw err;
                expect(fs.existsSync(base + "/foo/bar.txt")).not.ok;
                expect(fs.existsSync(base + "/foo")).not.ok;
                next();
            });
        });
        */
    });

    // Taken from vfs local
    describe('vfs.extend()', function() {
        it("should extend using a local file", function(done) {
            vfs.extend("math", {
                file: __dirname + "/math.js"
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                var api = meta.api;
                expect(api).property("add").a("function");
                expect(api).property("multiply").a("function");
                api.add(3, 4, function(err, result) {
                    if (err) throw err;
                    expect(result).equal(3 + 4);
                    vfs.unextend("math", {}, done);
                });
            });
        });
        it("should extend using a string", function(done) {
            var code = fs.readFileSync(__dirname + "/math.js", "utf8");
            vfs.extend("math2", {
                code: code
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                var api = meta.api;
                expect(api).property("add").a("function");
                expect(api).property("multiply").a("function");
                api.add(3, 4, function(err, result) {
                    if (err) throw err;
                    expect(result).equal(3 + 4);
                    vfs.unextend("math2", {}, done);
                });
            });
        });
        it("should extend using a stream", function(done) {
            var stream = fs.createReadStream(__dirname + "/math.js");
            vfs.extend("math3", {
                stream: stream
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                var api = meta.api;
                expect(api).property("add").a("function");
                expect(api).property("multiply").a("function");
                api.add(3, 4, function(err, result) {
                    if (err) throw err;
                    expect(result).equal(3 + 4);
                    vfs.unextend("math3", {}, done);
                });
            });
        });
        it("should error with EEXIST if the same extension is added twice", function(done) {
            vfs.extend("math", {
                file: __dirname + "/math.js"
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                vfs.extend("math", {
                    file: __dirname + "/math.js"
                }, function(err, meta) {
                    expect(err).property("code").equal("EEXIST");
                    vfs.unextend("math", {}, done);
                });
            });
        });
        it("should allow a redefine if options.redefine is set", function(done) {
            vfs.extend("test", {
                file: __dirname + "/math.js"
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                vfs.extend("test", {
                    redefine: true,
                    file: __dirname + "/math.js"
                }, function(err, meta) {
                    if (err) throw err;
                    expect(meta).property("api").ok;
                    vfs.unextend("test", {}, done);
                });
            });
        });
    });

    // Taken from vfs local
    describe('vfs.unextend()', function() {
        it("should remove an extension", function(done) {
            vfs.extend("math7", {
                file: __dirname + "/math.js"
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                vfs.use("math7", {}, function(err, meta) {
                    if (err) throw err;
                    expect(meta).property("api").ok;
                    vfs.unextend("math7", {}, function(err, meta) {
                        if (err) throw err;
                        vfs.use("math7", {}, function(err, meta) {
                            expect(err).property("code").equal("ENOENT");
                            done();
                        });
                    });
                });
            });
        });
    });

    describe('vfs.use()', function() {
        it("should load an existing api", function(done) {
            vfs.extend("math4", {
                file: __dirname + "/math.js"
            }, function(err, meta) {
                if (err) throw err;
                expect(meta).property("api").ok;
                vfs.use("math4", {}, function(err, meta) {
                    if (err) throw err;
                    expect(meta).property("api").ok;
                    var api = meta.api;
                    expect(api).property("add").a("function");
                    expect(api).property("multiply").a("function");
                    api.add(3, 4, function(err, result) {
                        if (err) throw err;
                        expect(result).equal(3 + 4);
                        vfs.unextend("math4", {}, done);
                    });
                });
            });
        });
        it("should error with ENOENT if the api doesn't exist", function(done) {
            vfs.use("notfound", {}, function(err, meta) {
                expect(err).property("code").equal("ENOENT");
                done();
            });
        });
    });

    describe('vfs.on(), vfs.off(), vfs.emit()', function() {
        it("should register an event listener and catch an event", function(done) {
            vfs.on("myevent", onEvent, function(err) {
                if (err) throw err;
                vfs.emit("myevent", 42, function(err) {
                    if (err) throw err;
                });
            });

            function onEvent(data) {
                expect(data).equal(42);
                vfs.off("myevent", onEvent, done);
            }
        });
        it("should catch multiple events of the same type", function(done) {
            var times = 0;
            vfs.on("myevent", onEvent, function(err) {
                if (err) throw err;
                vfs.emit("myevent", 43, function(err) {
                    if (err) throw err;
                });
                vfs.emit("myevent", 43, function(err) {
                    if (err) throw err;
                });
            });

            function onEvent(data) {
                expect(data).equal(43);
                if (++times === 2) {
                    vfs.off("myevent", onEvent, done);
                }
            }
        });
        it("should call multiple listeners for a single event", function(done) {
            var times = 0;
            vfs.on("myevent", onEvent1, function(err) {
                if (err) throw err;
                vfs.on("myevent", onEvent2, function(err) {
                    if (err) throw err;
                    vfs.emit("myevent", 44, function(err) {
                        if (err) throw err;
                    });
                });
            });

            function onEvent1(data) {
                expect(data).equal(44);
                times++;
            }

            function onEvent2(data) {
                expect(data).equal(44);
                if (++times === 2) {
                    vfs.off("myevent", onEvent1, function(err) {
                        if (err) throw err;
                        vfs.off("myevent", onEvent2, done);
                    });
                }
            }
        });
        it("should stop listening after a handler is removed", function(done) {
            vfs.on("myevent", onEvent, function(err) {
                if (err) throw err;
                vfs.emit("myevent", 45, function(err) {
                    if (err) throw err;
                    vfs.off("myevent", onEvent, function(err) {
                        if (err) throw err;
                        vfs.emit("myevent", 46, done);
                    });
                });
            });

            function onEvent(data) {
                expect(data).equal(45);
            }
        });
    });

    describe("notsupported", function() {
        it("should not support watch()", function(next) {
            vfs.watch("test", {}, function(err, meta) {
                assert.equal(err.code, "ENOTSUPPORTED");
                next();
            });
        });

        it("should not support spawn()", function(next) {
            vfs.spawn("test", {}, function(err, meta) {
                assert.equal(err.code, "ENOTSUPPORTED");
                next();
            });
        });

        it("should not support symlink()", function(next) {
            vfs.symlink("test", {}, function(err, meta) {
                assert.equal(err.code, "ENOTSUPPORTED");
                next();
            });
        });

        it("should not support connect()", function(next) {
            vfs.connect(10, {}, function(err, meta) {
                assert.equal(err.code, "ENOTSUPPORTED");
                next();
            });
        });

        it("should not support execFile()", function(next) {
            vfs.execFile("test", {}, function(err, meta) {
                assert.equal(err.code, "ENOTSUPPORTED");
                next();
            });
        });
    });
});
