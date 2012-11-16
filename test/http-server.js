var exec = require("child_process").spawn;
var rl = require('readline');

var i = rl.createInterface(process.stdin, process.stdout, null);
// Fill this up with your FTP credentials
var daemon = exec('python', ['../node_modules/jsftp/test/basic_ftpd.py']);

var FTPCredentials = {
    host: "localhost",
    user: "user",
    port: 3334,
    pass: "12345"
};

var startServer = function() {
    var vfs = require('../ftp')({ credentials: FTPCredentials });
    require('http').createServer(require('stack')(
        require('vfs-http-adapter')("/", vfs)
    )).listen(8080, function () {
        console.log("FTP at http://localhost:8080/");
    });
};

if (!FTPCredentials.user || !FTPCredentials.pass) {
    i.question("Enter username: ", function (username) {
        i.question("Enter password: ", function (password) {
            FTPCredentials.user = username;
            FTPCredentials.pass = password;

            startServer();
        });
    });
}
else {
    startServer();
}

