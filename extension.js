var vscode = require('vscode');
var Client = require('ssh2').Client;

function activate(context) {
    console.log('Initializing lighthouse plugin...');

    var disposable = vscode.commands.registerCommand('armada.inspect', function () {
        clusters = vscode.workspace.getConfiguration('lighthouse.clusters')

        

        for (i = 0; i < clusters.length; i++) {
            try {
                var conn = new Client();
                conn.on('ready', function () {
                    console.log('Client :: ready');
                    conn.shell(function (err, stream) {
                        if (err) throw err;
                        stream.on('close', function () {
                            console.log('Stream :: close');
                            conn.end();
                        }).on('data', function (data) {
                            console.log('STDOUT: ' + data);
                        }).stderr.on('data', function (data) {
                            console.log('STDERR: ' + data);
                        });
                        stream.end('ls -l\nexit\n');
                    });
                }).connect({
                    host: clusters[i].host,
                    port: clusters[i].port,
                    username: clusters[i].user,
                    password: clusters[i].password
                });
            } catch (e) {
                console.log(e);
            }
        }
    });

    context.subscriptions.push(disposable);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;