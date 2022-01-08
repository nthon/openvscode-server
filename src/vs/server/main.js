/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const perf = require('../base/common/performance');
const performance = require('perf_hooks').performance;
const product = require('../../../product.json');
const readline = require('readline');
const http = require('http');

perf.mark('code/server/start');
// @ts-ignore
global.vscodeServerStartTime = performance.now();

async function start() {
	if (process.argv[2] === '--exec') {
		process.argv.splice(1, 2);
		require(process.argv[1]);
		return;
	}

	const minimist = require('minimist');

	// Do a quick parse to determine if a server or the cli needs to be started
	const parsedArgs = minimist(process.argv.slice(2), {
		boolean: ['start-server', 'list-extensions', 'print-ip-address', 'help', 'version', 'accept-server-license-terms'],
		string: ['install-extension', 'install-builtin-extension', 'uninstall-extension', 'locate-extension', 'socket-path', 'host', 'port', 'pick-port']
	});

	const extensionCliArgs = ['list-extensions', 'install-extension', 'install-builtin-extension', 'uninstall-extension', 'locate-extension'];

	const shouldSpawnCli = parsedArgs.help || parsedArgs.version || !parsedArgs['start-server'] && extensionCliArgs.some(a => !!parsedArgs[a]);

	if (shouldSpawnCli) {
		loadCode().then((mod) => {
			mod.spawnCli();
		});
		return;
	}

	/**
	 * @typedef { import('./remoteExtensionHostAgentServer').IServerAPI } IServerAPI
	 */
	/** @type {IServerAPI | null} */
	let _remoteExtensionHostAgentServer = null;
	/** @type {Promise<IServerAPI> | null} */
	let _remoteExtensionHostAgentServerPromise = null;
	/** @returns {Promise<IServerAPI>} */
	const getRemoteExtensionHostAgentServer = () => {
		if (!_remoteExtensionHostAgentServerPromise) {
			_remoteExtensionHostAgentServerPromise = loadCode().then((mod) => mod.createServer(address));
		}
		return _remoteExtensionHostAgentServerPromise;
	};

	const http = require('http');
	const os = require('os');

	if (Array.isArray(product.serverLicense) && product.serverLicense.length) {
		console.log(product.serverLicense.join('\n'));
		if (product.serverLicensePrompt && parsedArgs['accept-server-license-terms'] !== true) {
			try {
				const accept = await prompt(product.serverLicensePrompt);
				if (!accept) {
					process.exit();
				}
			} catch (e) {
				console.log(e);
				process.exit();
			}
		}
	}

	let firstRequest = true;
	let firstWebSocket = true;

	/** @type {string | import('net').AddressInfo | null} */
	let address = null;
	const server = http.createServer(async (req, res) => {
		if (firstRequest) {
			firstRequest = false;
			perf.mark('code/server/firstRequest');
		}
		const remoteExtensionHostAgentServer = await getRemoteExtensionHostAgentServer();
		return remoteExtensionHostAgentServer.handleRequest(req, res);
	});
	server.on('upgrade', async (req, socket) => {
		if (firstWebSocket) {
			firstWebSocket = false;
			perf.mark('code/server/firstWebSocket');
		}
		const remoteExtensionHostAgentServer = await getRemoteExtensionHostAgentServer();
		// @ts-ignore
		return remoteExtensionHostAgentServer.handleUpgrade(req, socket);
	});
	server.on('error', async (err) => {
		const remoteExtensionHostAgentServer = await getRemoteExtensionHostAgentServer();
		return remoteExtensionHostAgentServer.handleServerError(err);
	});
	const nodeListenOptions = (
		parsedArgs['socket-path']
			? { path: parsedArgs['socket-path'] }
			: { host: parsedArgs['host'], port: await parsePort(parsedArgs['port'], parsedArgs['pick-port']) }
	);
	server.listen(nodeListenOptions, async () => {
		const serverGreeting = product.serverGreeting.join('\n');
		let output = serverGreeting ? `\n\n${serverGreeting}\n\n` : ``;

		if (typeof nodeListenOptions.port === 'number' && parsedArgs['print-ip-address']) {
			const ifaces = os.networkInterfaces();
			Object.keys(ifaces).forEach(function (ifname) {
				ifaces[ifname].forEach(function (iface) {
					if (!iface.internal && iface.family === 'IPv4') {
						output += `IP Address: ${iface.address}\n`;
					}
				});
			});
		}

		address = server.address();
		if (address === null) {
			throw new Error('Unexpected server address');
		}

		// Do not change this line. VS Code looks for this in the output.
		output += `Extension host agent listening on ${typeof address === 'string' ? address : address.port}\n`;
		console.log(output);

		perf.mark('code/server/started');
		// @ts-ignore
		global.vscodeServerListenTime = performance.now();

		await getRemoteExtensionHostAgentServer();
	});

	process.on('exit', () => {
		server.close();
		if (_remoteExtensionHostAgentServer) {
			_remoteExtensionHostAgentServer.dispose();
		}
	});
}

/**
 * If `--pick-port` and `--port` is specified, connect to that port.
 *
 * If not and a port range is specified through `--pick-port`
 * then find a free port in that range. Throw error if no
 * free port available in range.
 *
 * If only `--port` is provided then connect to that port.
 *
 * In absence of specified ports, connect to port 3000.
 * @param {string | undefined} strPort
 * @param {string | undefined} strPickPort
 * @returns {Promise<number>}
 * @throws
 */
async function parsePort(strPort, strPickPort) {
	let specificPort;
	if (strPort) {
		let range;
		if (strPort.match(/^\d+$/)) {
			specificPort = parseInt(strPort, 10);
			if (specificPort === 0 || !strPickPort) {
				return specificPort;
			}
		} else if (range = parseRange(strPort)) {
			return await findFreePort(range.start, range.end, 3000);
		} else {
			console.log('--port "${strPort}" is not a valid number or range.');
		}
	}
	if (strPickPort) {
		const range = parseRange(strPickPort);
		if (range) {
			if (range.start <= specificPort && specificPort <= range.end) {
				return specificPort;
			} else {
				return await findFreePort(range.start, range.end, 3000);
			}
		} else {
			console.log(`--pick-port "${strPickPort}" is not properly formatted.`);
		}
	}
	return 3000;
}

/**
 * @param {string} strRange
 * @returns {{ start: number; end: number } | undefined}
 */
function parseRange(strRange) {
	const match = strRange.match(/^(\d+)-(\d+)$/);
	if (match) {
		return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) };
	}
	return undefined;
}

/**
 * Starting at the `start` port, look for a free port incrementing
 * by 1 until `end` inclusive. If no free port is found, the fallback is returned.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} fallback
 * @returns {Promise<number>}
 * @throws
 */
async function findFreePort(start, end, fallback) {
	const testPort = (port) => {
		return new Promise((resolve) => {
			const server = http.createServer();
			server.listen(port, '127.0.0.1', () => {
				server.close();
				resolve(true);
			}).on('error', () => {
				resolve(false);
			});
		});
	};
	for (let port = start; port < end; port++) {
		if (await testPort(port)) {
			return port;
		}
	}
	console.log(`Could not find free port in range: ${start}-${end}. Using ${fallback} instead.`);
	return fallback;
}

/** @returns { Promise<typeof import('./remoteExtensionHostAgent')> } */
function loadCode() {
	return new Promise((resolve, reject) => {
		const path = require('path');

		// Set default remote native node modules path, if unset
		process.env['VSCODE_INJECT_NODE_MODULE_LOOKUP_PATH'] = process.env['VSCODE_INJECT_NODE_MODULE_LOOKUP_PATH'] || path.join(__dirname, '..', '..', '..', 'remote', 'node_modules');
		require('../../bootstrap-node').injectNodeModuleLookupPath(process.env['VSCODE_INJECT_NODE_MODULE_LOOKUP_PATH']);
		require('../../bootstrap-amd').load('vs/server/remoteExtensionHostAgent', resolve, reject);
	});
}

/**
 * @param {string} question
 * @returns { Promise<boolean> }
 */
function prompt(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	return new Promise((resolve, reject) => {
		rl.question(question + ' ', async function (data) {
			rl.close();
			const str = data.toString().trim().toLowerCase();
			if (str === '' || str === 'y' || str === 'yes') {
				resolve(true);
			} else if (str === 'n' || str === 'no') {
				resolve(false);
			} else {
				process.stdout.write('\nInvalid Response. Answer either yes (y, yes) or no (n, no)\n');
				resolve(await prompt(question));
			}
		});
	});
}


start();
