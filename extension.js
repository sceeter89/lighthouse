var vscode = require('vscode');
var Client = require('ssh2').Client;

function runCommandViaSsh(ssh_config, command) {
    return new Promise(function (resolve, reject) {
        var output = []
        var exitCode = 0;
        var conn = new Client();
        conn.on('ready', function () {
            console.log('Executing command: ' + command + ' @ ' + ssh_config.host);
            conn.exec(command, function (err, stream) {
                if (err) reject(err);
                stream.on('close', function (code, signal) {
                    conn.end();
                    if (exitCode !== 0)
                        reject('Exit code: ' + exitCode);
                    else {
                        resolve(output.join('\n'));
                    }
                    console.log('Exit code: ' + exitCode);
                }).on('data', function (data) {
                    output.push(data);
                    console.log('STDOUT: ' + data);
                }).on('exit', function (code) {
                    exitCode = code;
                }).stderr.on('data', function (data) {
                    console.log('STDERR: ' + data);
                });
            });
        }).connect(ssh_config);
    });
}

function runCommandInContainer(ssh_config, container, command) {
    return new Promise(function (resolve, reject) {
        var full_command = "armada ssh " + container.container_id + " " + command;
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
            var dockyards = []
            var lines = output.trim().split('\n').slice(1);
            lines.forEach(function (line) {
                var dockyard = {}
                var columns = line.split(/[ ]+/).filter(function (item) { return item !== ""; });
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
        var load = {}
        runCommandInContainer(ssh_config, armada_service, 'cat /ship_root_dir/proc/loadavg')
            .then(function (output) {
                loadavg = output.split(/\s+/).filter(function (item) { return item !== ""; });
                load.averageLoad1 = parseFloat(loadavg[0]);
                load.averageLoad5 = parseFloat(loadavg[1]);
                load.averageLoad15 = parseFloat(loadavg[2]);
                return runCommandInContainer(ssh_config, armada_service, 'cat /ship_root_dir/proc/meminfo');
            }).then(function (output) {
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
            }).then(function (output) {
                load.cpuCount = parseInt(output);
                resolve(load);
            });
    });
}

function getSshConfigForCluster(cluster) {
    sshConfig = {
        host: cluster.host,
        port: cluster.port,
        username: cluster.user,
        password: cluster.password,
        passphrase: cluster.passphrase
    };
    if (cluster.private_key) {
        sshConfig.privateKey = require("fs").readFileSync(cluster.private_key);
    }
    return sshConfig;
}

function inspectSingleCluster(c) {
    var cluster = c;
    return new Promise(function (resolve, reject) {
        var sshConfig = getSshConfigForCluster(cluster);
        runCommandViaSsh(sshConfig, 'curl http://localhost:8500/v1/catalog/nodes')
            .then(function (response) {
                var nodes = JSON.parse(response);
                var results = {}
                nodes.forEach(function (node) {
                    results[node.Address] = { 'node': node };
                });

                var markers = [];

                nodes.forEach(function (node) {
                    getNodeRunningServices(sshConfig, node).then(function (services) {
                        results[node.Address]['services'] = services;
                        services.forEach(function (service) {
                            if (service.name == "armada") {
                                results[node.Address]['armada_service'] = service;
                            }
                        });
                        return getNodeDockyards(sshConfig, results[node.Address]['armada_service']);
                    }).then(function (dockyards) {
                        results[node.Address]['dockyards'] = dockyards;
                        return getNodeLoad(sshConfig, results[node.Address]['armada_service']);
                    }).then(function (load) {
                        results[node.Address]['load'] = load;
                        markers.push(node);
                        if (markers.length == Object.keys(results).length) {
                            resolve(results);
                        }
                    });
                });
            });
    });
}

function inspectClusters() {
    try {
        var clusters_connections = vscode.workspace.getConfiguration('lighthouse.clusters');
        var cluster_inspections = [];
        vscode.commands.executeCommand("workbench.action.files.newUntitledFile").then(function () {
            for (i = 0; i < clusters_connections.length; i++) {
                var cluster = clusters_connections[i];
                inspectSingleCluster(cluster).then(function (result) {
                    cluster_inspections.push(result);

                    if (cluster_inspections.length == clusters_connections.length) {
                        vscode.window.activeTextEditor.edit(function (editor) {
                            editor.insert(new vscode.Position(0, 0), JSON.stringify(cluster_inspections, null, '\t'));
                        });
                    }
                }).catch(function (reason) { throw reason; });
            }
        });
    } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage('Failed to complete inspection. Details logged to console.');
    }
}

function selectCluster() {
    return new Promise(function (resolve, reject) {
        var clusters_connections = vscode.workspace.getConfiguration('lighthouse.clusters');
        var options = clusters_connections.map(function (c) { return c.name; });
        vscode.window.showQuickPick(options).then(function (cluster_name) {
            clusters_connections.forEach(function (c) {
                if (c.name != cluster_name) return;
                resolve(c);
                return;
            });
            reject('No valid option selected.');
        });
    });
}

function runArmadaService(cluster, parameters, overrideEnv, overrideAppId) {
    var instancesCount = parameters.instances || 1;

    if (!parameters.serviceName) {
        vscode.window.showErrorMessage('"serviceName" is obligatory for every service');
        return;
    }

    var env = overrideEnv || parameters.env;
    var appId = overrideAppId || parameters.appId;
    var dockyard = parameters.dockyardAlias;
    var memoryLimit = parameters.memoryLimit;
    var memorySwapLimit = parameters.memorySwapLimit;
    var renameTo = parameters.renameTo;

    var commandParameters = [parameters.serviceName];
    if (env)
        commandParameters.push('--env ' + env);
    if (appId)
        commandParameters.push('--app_id ' + appId);
    if (dockyard)
        commandParameters.push('-d ' + dockyard);
    if (memoryLimit)
        commandParameters.push('--memory ' + memoryLimit);
    if (memorySwapLimit)
        commandParameters.push('--memory-swap ' + memorySwapLimit);
    if (renameTo)
        commandParameters.push('-r ' + renameTo);

    var command = "armada run " + commandParameters.join(" ");
    var sshConfig = getSshConfigForCluster(cluster);
    for (j = 0; j < instancesCount; j++) {
        runCommandViaSsh(sshConfig, command);
    }
}

function deployCurrentFile() {
    var text = vscode.window.activeTextEditor.document.getText();
    try {
        var deploymentConfig = JSON.parse(text);
        if (Array.isArray(deploymentConfig) === false) {
            vscode.window.showErrorMessage('Configuration has to be JSON array.');
            return;
        }
    } catch (e) {
        vscode.window.showErrorMessage('Current document doesn\'t contain valid JSON.');
        return;
    }
    try {
        selectCluster().then(function (cluster) {
            for (i = 0; i < deploymentConfig.length; i++) {
                var config = deploymentConfig[i];
                runArmadaService(cluster, config);
            }
        }).catch(function (reason) { throw reason; });
    } catch (e) {
        console.log(e);
        vscode.window.showErrorMessage('Failed to complete deployment. Details logged.');
        return;
    }
}

function insertDeploymentSnippet() {
    vscode.window.activeTextEditor.edit(function (editor) {
        editor.insert(new vscode.Position(0, 0), `
[
    {
        "serviceName": "example",
        "renameTo": "betterExample",
        "env": "dev",
        "app_id": null,
        "dockyardAlias": null,
        "memoryLimit": "100M",
        "memorySwapLimit": "0M",
        "instances": 2
    },
    {
        "serviceName": "mysql",
        "env": "dev",
        "app_id": "example_mysql",
        "memoryLimit": "512M",
        "memorySwapLimit": "100M",
        "instances": 1
    }
]
        `);
    });
}

function activate(context) {
    console.log('Initializing lighthouse plugin...');

    context.subscriptions.push(vscode.commands.registerCommand('armada.inspect_all', inspectClusters));

    context.subscriptions.push(vscode.commands.registerCommand('armada.inspect', function () {
        selectCluster().then(function (cluster) {
            vscode.commands.executeCommand("workbench.action.files.newUntitledFile").then(function () {
                inspectSingleCluster(cluster).then(function (result) {
                    vscode.window.activeTextEditor.edit(function (editor) {
                        editor.insert(new vscode.Position(0, 0), 'Cluster: ' + cluster.name + '\n\n');
                        editor.insert(new vscode.Position(0, 0), JSON.stringify(result, null, '\t'));
                    });
                })
            });
        }).catch(function (reason) {
            console.error(e);
            vscode.window.showErrorMessage('Failed to complete inspection. Details logged to console.');
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('armada.deploy', deployCurrentFile));
    context.subscriptions.push(vscode.commands.registerCommand('armada.init_deployment_file', insertDeploymentSnippet));
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;