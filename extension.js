var vscode = require('vscode');
var Client = require('ssh2').Client;

function runCommandViaSsh(ssh_config, command) {
    return new Promise(function (resolve, reject) {
        output = []
        exitCode = 0;
        var conn = new Client();
        conn.on('ready', function () {
            conn.exec(command, function (err, stream) {
                if (err) reject(err);
                stream.on('close', function (code, signal) {
                    conn.end();
                    if (exitCode !== 0)
                        reject('Exit code: ' + exitCode);
                    else {
                        resolve(output.join('\n'));
                    }
                }).on('data', function (data) {
                    output.push(data);
                }).on('exit', function (code) {
                    exitCode = code;
                });
            });
        }).connect(ssh_config);
    });
}

function runCommandInContainer(ssh_config, container, command) {
    return new Promise(function (resolve, reject) {
        full_command = "armada ssh " + container.container_id + " " + command;
        runCommandViaSsh(ssh_config, full_command)
            .then(function (output) {
                resolve(output);
            });
    });
}

function getNodeRunningServices(ssh_config, node) {
    return new Promise(function (resolve, reject) {
        runCommandViaSsh(ssh_config, 'curl http://localhost:8900/list?local=1')
            .then(function (response) {
                resolve(JSON.parse(response).result);
            });
    });
}

function getNodeDockyards(ssh_config, armada_service) {
    return new Promise(function (resolve, reject) {
        runCommandInContainer(ssh_config, armada_service, "armada dockyard list").then(function (output) {
            dockyards = []
            lines = output.trim().split('\n').slice(1);
            lines.forEach(function(line){
                dockyard = {}
                columns = line.split(/[ ]+/).filter(function(item) {return item !== "";});
                dockyard.is_default = columns[0] === "->";
                if (columns[0] === "->") columns = columns.slice(1);

                dockyard.alias = columns[0];
                dockyard.address = columns[1];
                dockyard.username = columns[2];
                dockyard.password = columns[3];

                dockyards.push(dockyard);
            });
            resolve(dockyards);
        })
    });
}

function getNodeLoad(ssh_config, armada_service) {
    return new Promise(function (resolve, reject) {
        var loadavg = "", meminfo = "";
        load = {}
        runCommandInContainer(ssh_config, armada_service, 'cat /ship_root_dir/proc/loadavg')
            .then(function(output) {
                loadavg = output.split(/\s+/).filter(function(item) {return item !== "";});
                load.averageLoad1 = parseFloat(loadavg[0]);
                load.averageLoad5 = parseFloat(loadavg[1]);
                load.averageLoad15 = parseFloat(loadavg[2]);
                return runCommandInContainer(ssh_config, armada_service, 'cat /ship_root_dir/proc/meminfo');
            }).then(function(output) {
                meminfo = output.split('\n');
                load.totalMemoryKB = parseInt(meminfo[0].split(/\s+/)[1]);
                load.freeMemoryKB = parseInt(meminfo[1].split(/\s+/)[1]);
                load.memoryUsedKB = load.totalMemoryKB - load.freeMemoryKB;                
                load.availableMemoryKB = parseInt(meminfo[2].split(/\s+/)[1]);
                load.buffers = parseInt(meminfo[3].split(/\s+/)[1]);
                load.cachedMemoryKB = parseInt(meminfo[4].split(/\s+/)[1]);
                load.swapTotalKB = parseInt(meminfo[14].split(/\s+/)[1]);
                load.swapFreeKB = parseInt(meminfo[15].split(/\s+/)[1]);
                load.swapUsedKB = load.swapTotalKB - load.swapFreeKB;
                return runCommandInContainer(ssh_config, armada_service, 'grep \"^processor\" /ship_root_dir/proc/cpuinfo | wc -l');
            }).then(function(output) {
                load.cpuCount = parseInt(output);                
                resolve(load);
            });
    });
}

function inspectSingleCluster(cluster) {
    return new Promise(function (resolve, reject) {
        ssh_config = {
            host: cluster.host,
            port: cluster.port,
            username: cluster.user,
            password: cluster.password
        };
        runCommandViaSsh(ssh_config, 'curl http://localhost:8500/v1/catalog/nodes')
            .then(function (response) {
                var nodes = JSON.parse(response);
                nodes_statistics = {}
                nodes.forEach(function (node) {
                    nodes_statistics[node.Address] = { 'node': node };
                });

                markers = [];

                nodes.forEach(function (node) {
                    getNodeRunningServices(ssh_config, node).then(function (services) {
                        nodes_statistics[node.Address]['services'] = services;
                        services.forEach(function (service) {
                            if (service.name == "armada") {
                                nodes_statistics[node.Address]['armada_service'] = service;
                            }
                        });
                        return getNodeDockyards(ssh_config, nodes_statistics[node.Address]['armada_service']);
                    }).then(function (dockyards) {
                        nodes_statistics[node.Address]['dockyards'] = dockyards;
                        return getNodeLoad(ssh_config, nodes_statistics[node.Address]['armada_service']);
                    }).then(function (load) {
                        nodes_statistics[node.Address]['load'] = load;
                        markers.push(node);
                        if (markers.length == Object.keys(nodes_statistics).length) {
                            resolve(nodes_statistics);
                        }
                    });
                });
            });
    });
}

function inspectClusters() {
    try {
        clusters = vscode.workspace.getConfiguration('lighthouse.clusters')

        vscode.commands.executeCommand("workbench.action.files.newUntitledFile").then(function () {
            for (i = 0; i < clusters.length; i++) {
                var cluster = clusters[i];
                inspectSingleCluster(cluster).then(function (result) {
                    vscode.window.activeTextEditor.edit(function (editor) {
                        editor.insert(new vscode.Position(0, 0), 'Cluster: ' + cluster.name + '\n');
                        editor.insert(new vscode.Position(0, 0), JSON.stringify(result, null, '\t') + '\n');
                        editor.insert(new vscode.Position(0, 0), '\n==============================================\n\n');
                    });
                }).catch(function(reason) {throw reason;});
            }
        });
    } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage('Failed to complete inspection. Details logged to console.');
    }
}

function activate(context) {
    console.log('Initializing lighthouse plugin...');

    var disposable = vscode.commands.registerCommand('armada.inspect', inspectClusters);

    context.subscriptions.push(disposable);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;