#!/usr/bin/env node
/**
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
 */

/**
  The top line of this file will allow this script to be run as
  a UNIX shell script, as well as being a valid Node.js program.
 */

/******************************************************************************/
/******************************************************************************/

function wscriptWrapper() {
  var shell = WScript.CreateObject("WScript.Shell");
  var args = [];
  for (var i = 0; i < WScript.Arguments.Length; ++i) {
    args.push('"' + WScript.Arguments.Item(i) + '"');
  }
  var ret;
  try {
    // Don't worry about passing along arguments here. It's stricly a double-click convenience.
    var cmd = 'cmd /c node "' + WScript.ScriptFullName + '" ' + args.join(' ') + ' --pause_on_exit';
    ret = shell.Run(cmd, 1, true);
  } catch (e) {
    shell.Popup('NodeJS is not installed. Please install it from http://nodejs.org');
    ret = 1;
  }
  WScript.Quit(ret);
}
if (typeof WScript != 'undefined') {
  wscriptWrapper();
}

/******************************************************************************/
/******************************************************************************/

// System modules.
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

// Third-party modules.
var ncp = require('ncp');
var optimist = require('optimist');
var Crypto = require('cryptojs').Crypto;
var et = require('elementtree');

// Globals
var isGitRepo = fs.existsSync(path.join(__dirname, '..', '.git')); // git vs npm
var commandLineFlags = null;
var origDir = process.cwd();
var isWindows = process.platform.slice(0, 3) == 'win';
var eventQueue = [];
var mcaRoot = path.join(__dirname, '..');
var scriptName = path.basename(process.argv[1]);
var hasAndroidSdk = false;
var hasAndroidPlatform = false;
var hasXcode = false;

/******************************************************************************/
/******************************************************************************/

var PLUGIN_SEARCH_PATH = [
    path.join(mcaRoot, 'cordova'),
    path.join(mcaRoot, 'cordova', 'cordova-plugins'),
    path.join(mcaRoot, 'chrome-cordova', 'plugins'),
];

var DEFAULT_PLUGINS = [
    'org.apache.cordova.file',
    'org.apache.cordova.inappbrowser',
    'org.apache.cordova.network-information',
    'org.apache.cordova.keyboard',
    'org.apache.cordova.statusbar',
    'org.chromium.navigation',
    'org.chromium.bootstrap',
    'org.chromium.i18n',
    'org.chromium.polyfill.CustomEvent',
    'org.chromium.polyfill.xhr_features',
    'org.chromium.polyfill.blob_constructor',
];

var PLUGIN_MAP = {
  'alarms': ['org.chromium.alarms'],
  'fileSystem': ['org.chromium.fileSystem',
                 'org.chromium.FileChooser'],
  'identity': ['org.chromium.identity'],
  'idle': ['org.chromium.idle'],
  'notifications': ['org.chromium.notifications'],
  'power': ['org.chromium.power'],
  'pushMessaging': ['org.chromium.pushMessaging'],
  'socket': ['org.chromium.socket'],
  'storage': ['org.chromium.storage'],
  'syncFileSystem': ['org.chromium.syncFileSystem'],
  'unlimitedStorage': []
};

/******************************************************************************/
/******************************************************************************/
// Utility Functions

function pump() {
  if (eventQueue.length) {
    eventQueue.shift()(pump);
  }
}

function exit(code) {
  if (eventQueue) {
    eventQueue.length = 0;
  }
  if (commandLineFlags['pause_on_exit']) {
    waitForKey(function() {
      process.exit(code);
    });
  } else {
    process.exit(code);
  }
}

function fatal(msg) {
  console.error(msg);
  exit(1);
}

function colorizeConsole() {
  var origWarn = console.warn;
  console.warn = function() {
    var msg = [].slice.call(arguments).join(' ');
    origWarn.call(console, '\x1B[33m' + msg + '\x1B[39m');
  };
  console.error = function() {
    var msg = [].slice.call(arguments).join(' ');
    origWarn.call(console, '\x1B[31m' + msg + '\x1B[39m');
  };
}

function exec(cmd, onSuccess, opt_onError, opt_silent) {
  var onError = opt_onError || function(e) {
    fatal('command failed: ' + cmd + '\n' + e);
  };
  if (!opt_silent) {
    console.log('Running: ' + cmd);
  }
  childProcess.exec(cmd, function(error, stdout, stderr) {
    if (error) {
      onError(error);
    } else {
      onSuccess(stdout.trim(), stderr.trim());
    }
  });
}

function spawn(cmd, args, onSuccess, opt_onError, opt_silent) {
  var onError = opt_onError || function(e) {
    fatal('command failed: ' + cmd + '\n' + e);
  };
  if (!opt_silent) {
    console.log('Spawning: ' + cmd + ' ' + args.join(' '));
  }
  var p = childProcess.spawn(cmd, args);

  p.stdout.on('data', function (data) {
    process.stdout.write(data);
  });
  p.stderr.on('data', function (data) {
    process.stderr.write(data);
  });

  process.stdin.resume();
  try {
    // This fails if the process is a spawned child (likely a node bug);
    process.stdin.setRawMode(true);
  } catch (e) {
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', forward);
  p.on('close', function (code) {
    process.stdin.removeListener('data', forward);
    process.stdin.pause();
    onSuccess();
  });
  function forward(data) {
    p.stdin.write(data);
  }
}

function chdir(d) {
  d = path.resolve(mcaRoot, d);
  if (process.cwd() != d) {
    console.log('Changing directory to: ' + d);
    process.chdir(d);
  }
}

function copyFile(src, dst, callback) {
  var rd = fs.createReadStream(src);
  var wr = fs.createWriteStream(dst);
  wr.on('error', function(err) {
    fatal('Copy file error: ' + err);
  });
  wr.on('close', callback);
  rd.pipe(wr);
}

function copyDirectory(src, dst, callback) {
  ncp.ncp(src, dst, function(err) {
    if (err) {
      fatal('Copy file error: ' + err);
    } else {
      callback();
    }
  });
}

function recursiveDelete(dirPath) {
  if (fs.existsSync(dirPath)) {
    console.log('Deleting: ' + dirPath);
    helper(dirPath);
  }
  function helper(dirPath) {
    try {
       var files = fs.readdirSync(dirPath);
    } catch(e) {
      return;
    }
    for (var i = 0; i < files.length; i++) {
      var filePath = path.join(dirPath, files[i]);
      fs.chmodSync(filePath, '777');
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      } else {
        helper(filePath);
      }
    }
    fs.rmdirSync(dirPath);
  }
}

function waitForKey(opt_prompt, callback) {
  if (typeof opt_prompt == 'function') {
    callback = opt_prompt;
    opt_prompt = 'Press the Any Key';
  }
  process.stdout.write(opt_prompt);
  process.stdin.resume();
  try {
    // This fails if the process is a spawned child (likely a node bug);
    process.stdin.setRawMode(true);
  } catch (e) {
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function cont(key) {
    if (key == '\u0003') {
      process.exit(2);
    }
    process.stdin.removeListener('data', cont);
    process.stdin.pause();
    process.stdout.write('\n');
    callback(key);
  });
}

function readManifest(manifestFilename, callback) {
  fs.readFile(manifestFilename, { encoding: 'utf-8' }, function(err, data) {
    if (err) {
      fatal('Unable to open manifest ' + manifestFilename + ' for reading.');
    }
    try {
      var manifest = eval('(' + data + ')'); // JSON.parse(data);
      callback(manifest);
    } catch (e) {
      console.log(e);
      fatal('Unable to parse manifest ' + manifestFilename);
    }
  });
}

function mapAppKeyToAppId(key) {
  var mpdec = {'0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f', '6': 'g', '7': 'h',
               '8': 'i', '9': 'j', 'a': 'k', 'b': 'l', 'c': 'm', 'd': 'n', 'e': 'o', 'f': 'p' };
  return (Crypto.SHA256(new Buffer(key, 'base64'))
          .substr(0,32)
          .replace(/[a-f0-9]/g, function(char) {
             return mpdec[char];
          }));
}

function parseManifest(manifest, callback) {
  var permissions = [],
      chromeAppId,
      whitelist = [],
      plugins = [],
      i;
  if (manifest && manifest.permissions) {
    for (i = 0; i < manifest.permissions.length; ++i) {
      if (typeof manifest.permissions[i] === "string") {
        if (manifest.permissions[i].indexOf('://') > -1) {
          // Check for wildcard path scenario: <scheme>://<host>/ should translate to <scheme>://<host>/*
          if (/:\/\/[^\/]+\/$/.test(manifest.permissions[i])) {
            manifest.permissions[i] += "*";
          }
          whitelist.push(manifest.permissions[i]);
        } else if (manifest.permissions[i] === "<all_urls>") {
          whitelist.push("*");
        } else {
          permissions.push(manifest.permissions[i]);
        }
      } else {
        permissions = permissions.concat(Object.keys(manifest.permissions[i]));
      }
    }
  }
  for (i = 0; i < permissions.length; i++) {
    var pluginsForPermission = PLUGIN_MAP[permissions[i]];
    if (pluginsForPermission) {
      for (var j = 0; j < pluginsForPermission.length; ++j) {
        plugins.push(pluginsForPermission[j]);
      }
    } else {
      console.warn('Unsupported manifest permission encountered: ' + permissions[i] + ' (skipping)');
    }
  }
  if (manifest.key) {
    chromeAppId = mapAppKeyToAppId(manifest.key);
  } else {
    // All zeroes -- should we use rand() here instead?
    chromeAppId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }
  callback(chromeAppId, whitelist, plugins);
}

/******************************************************************************/
/******************************************************************************/
// Tools Check

function parseTargetOutput(targetOutput) {
  var targets = [];
  var target;
  var targetRe = /^id: (\d+) or "([^"]*)"/gm;
  while (target = targetRe.exec(targetOutput)) {
    targets.push(target[2]);
  }
  return targets;
}

function toolsCheck() {
  function printHeader(callback) {
    console.log('## Checking that tools are installed');
    callback();
  }
  function checkAndroid(callback) {
    exec('android list targets', function(targetOutput) {
      hasAndroidSdk = true;
      console.log('Android SDK detected.');
      var targets = parseTargetOutput(targetOutput);
      /* This is the android SDK version declared in cordova-android/framework/project.properties */
      if (targets.length === 0) {
          console.log('No Android Platforms are installed');
      } else if (targets.indexOf('Google Inc.:Google APIs:19') > -1 ||
                 targets.indexOf('android-19') > -1) {
          hasAndroidPlatform = true;
      } else {
          console.warn('Android 4.4 (Google APIs) Platform is not installed.');
      }
      callback();
    }, function() {
      console.log('Android SDK not detected on your PATH.');
      callback();
    }, true);
  }
  function checkXcode(callback) {
    if (process.platform == 'darwin') {
      exec('which xcodebuild', function() {
        exec('xcodebuild -version', function() {
          hasXcode = true;
          console.log('Xcode detected.');
          callback();
        }, function() {
          console.log('Xcode appears to be installed, but no version is selected (fix this with xcodeselect).');
          callback();
        }, true);
      }, function() {
        console.log('Xcode not detected.');
        callback();
      }, true);
    } else {
      callback();
    }
  }
  function checkAtLeastOneTool(callback) {
    if (!hasAndroidPlatform && !hasXcode) {
      if (process.platform == 'darwin') {
        fatal('No usable build environment could be found. Please install either XCode or the Android SDK and try again.');
      } else {
        fatal('No usable build environment could be found. Please install the Android SDK, make sure that android is on your PATH, and try again.');
      }
    }
    callback();
  }
  function checkNodeVersion(callback) {
    if (!os.tmpdir) {
      fatal('Your version of node (' + process.version + ') is too old. Please update your version of node.');
    }
    callback();
  }
  eventQueue.push(printHeader);
  eventQueue.push(checkNodeVersion);
  eventQueue.push(checkAndroid);
  eventQueue.push(checkXcode);
  eventQueue.push(checkAtLeastOneTool);
}

/******************************************************************************/
/******************************************************************************/

function ensureHasRunInit() {
  eventQueue.push(function(callback) {
    if (!fs.existsSync(path.join(mcaRoot, 'chrome-cordova/README.md')))
      return fatal('Please run \'' + scriptName + ' init\' first');
    callback();
  });
}

function promptIfNeedsGitUpdate() {
  eventQueue.push(function(callback) {
    process.chdir(mcaRoot);
    exec('git pull --rebase --dry-run', function(stdout, stderr) {
      var needsUpdate = (!!stdout || !!stderr);
      if (!needsUpdate)
        return callback();

      console.warn('Warning: mobile-chrome-apps has updates pending; Please run \'' + scriptName + ' init\'');
      waitForKey('Continue anyway? [y/n] ', function(key) {
        if (key.toLowerCase() !== 'y')
          return exit(1);
        callback();
      });
    }, function(error) {
      console.warn("Could not check repo for updates:");
      console.warn(error.toString());
      callback();
    }, true);
  });
}


/******************************************************************************/
/******************************************************************************/
// Init

function initCommand() {
  function checkGit(callback) {
    var errMsg = 'git is not installed (or not available on your PATH). Please install it from http://git-scm.com';
    exec('git --version', callback, function() {
      if (isWindows) {
        // See if it's at the default install path.
        process.env['PATH'] += ';' + path.join(process.env['ProgramFiles'], 'Git', 'bin');
        exec('git --version', callback, function() {
          fatal(errMsg);
        }, true);
      } else {
        fatal(errMsg);
      }
    }, true);
  }

  function checkOutSelf(callback) {
    console.log('## Updating mobile-chrome-apps');

    process.chdir(mcaRoot);
    exec('git pull --rebase', callback);
  }

  function checkOutSubModules(callback) {
    console.log('## Updating git submodules');

    process.chdir(mcaRoot);

    var error = function(error) {
      console.log("Could not update submodules:");
      console.warn(error.toString());
      console.log("Continuing without update.");
      callback();
    }
    exec('git submodule status', function(stdout) {
      var isFirstInit = stdout.split('\n').some(function(s) { return s[0] == '-'; });
      if (isFirstInit) {
        console.warn('The next step may take a while the first time.');
      }
      exec('git submodule update --init --recursive', callback, error);
    }, error);
  }

  function cleanup(callback) {
    process.chdir(origDir);
    callback();
  }

  if (isGitRepo) {
    eventQueue.push(checkGit);
    eventQueue.push(checkOutSelf);
    eventQueue.push(checkOutSubModules);
  }
  eventQueue.push(cleanup);
}

/******************************************************************************/
/******************************************************************************/

function runCmd(cordova, cmd, callback) {
  // Hack to remove the obj passed to the cordova create command.
  console.log(cmd.join(' ').replace('[object Object]', ''));
  cordova[cmd[0]].apply(cordova, cmd.slice(1).concat([callback]));
}

function runAllCmds(cordova, commands, callback) {
  if (commands.length === 0) {
    return callback();
  }
  var curCmd = commands[0],
      moreCommands = commands.slice(1);
  runCmd(cordova, curCmd, function(err) {
    if (err)
      return fatal(err);
    runAllCmds(cordova, moreCommands, callback);
  });
}


/******************************************************************************/
/******************************************************************************/
// Create App

function createCommand(appId, addAndroidPlatform, addIosPlatform) {
  var match = /[a-z]+\.[a-z][a-z0-9_]*\.([a-z][a-z0-9_]*)/i.exec(appId);
  if (!match) {
    fatal('App Name must be a valid Java package name and follow the pattern: com.company.id');
  }
  var destAppDir = match[1];
  var srcAppDir = null;
  var manifestFile = null;
  var manifest = null;

  var whitelist = [];
  var plugins = [];
  var chromeAppId;

  var cordova = require('cordova');

  function resolveTilde(string) {
    // TODO: implement better
    if (string.substr(0,1) === '~')
      return path.resolve(process.env.HOME + string.substr(1))
    return string
  }
  function validateSourceArgStep(callback) {
    var sourceArg = commandLineFlags.source;
    if (!sourceArg) {
      srcAppDir = path.join(mcaRoot, 'templates', 'default-app');
      manifestFile = path.join(srcAppDir, 'manifest.json');
    } else {
      var dirsToTry = [
        sourceArg && path.resolve(origDir, resolveTilde(sourceArg)),
        sourceArg === 'spec' && path.join(mcaRoot, 'chrome-cordova', 'spec', 'www')
      ];
      var foundManifest = false;
      for (var i = 0; i < dirsToTry.length; i++) {
        if (dirsToTry[i]) {
          srcAppDir = dirsToTry[i];
          console.log('Searching for Chrome app source in ' + srcAppDir);
          if (fs.existsSync(srcAppDir)) {
            manifestFile = path.join(srcAppDir, 'manifest.json');
            if (fs.existsSync(manifestFile)) {
              foundManifest = true;
              break;
            }
          }
        }
      }
      if (!srcAppDir) {
        fatal('Directory does not exist.');
      }
      if (!foundManifest) {
        fatal('No manifest.json file found');
      }
    }
    callback();
  }

  function readManifestStep(callback) {
    readManifest(manifestFile, function(manifestData) {
      parseManifest(manifestData, function(chromeAppIdFromManifest, whitelistFromManifest, pluginsFromManifest) {
        // Set globals
        manifest = manifestData;
        chromeAppId = chromeAppIdFromManifest;
        whitelist = whitelistFromManifest;
        plugins = pluginsFromManifest;
        callback();
      });
    });
  }

  function createStep(callback) {
    console.log('## Creating Your Application');
    chdir(origDir);

    var platformSpecified = addAndroidPlatform || addIosPlatform;
    var cmds = [];

    if ((!platformSpecified && hasXcode) || addIosPlatform) {
      cmds.push(['platform', 'add', 'ios']);
    }
    if ((!platformSpecified && hasAndroidSdk) || addAndroidPlatform) {
      cmds.push(['platform', 'add', 'android']);
    }
    DEFAULT_PLUGINS.forEach(function(pluginID) {
      cmds.push(['plugin', 'add', pluginID]);
    });
    plugins.forEach(function(pluginPath) {
      cmds.push(['plugin', 'add', pluginPath]);
    });

    function afterAllCommands() {
      // Create scripts that update the cordova app on prepare
      fs.mkdirSync('hooks/before_prepare');
      fs.mkdirSync('hooks/after_prepare');

      function writeHook(path, cmd) {
        var contents = [
            '#!/usr/bin/env node',
            'var spawn = require("child_process").spawn;',
            'var p = spawn("' + (isGitRepo ? './mca' : 'mca') + '", ["' + cmd + '"], { stdio:"inherit" });',
            'p.on("close", function(code) { process.exit(code); });',
            ];
        fs.writeFileSync(path, contents.join('\n'));
        fs.chmodSync(path, '777');
      }
      writeHook('hooks/before_prepare/mca-pre-prepare.js', 'pre-prepare');
      writeHook('hooks/after_prepare/mca-post-prepare.js', 'update-app');

      // Create a convenience link to MCA
      if (isGitRepo) {
        var mcaPath = path.relative('.', path.join(mcaRoot, 'mca'));
        var comment = 'Feel free to rewrite this file to point at "mca" in a way that works for you.';
        fs.writeFileSync('mca.cmd', 'REM ' + comment + '\r\n"' + mcaPath.replace(/\//g, '\\') + '" %*\r\n');
        fs.writeFileSync('mca', '#!/bin/sh\n# ' + comment + '\nexec "' + mcaPath.replace(/\\/g, '/') + '" "$@"\n');
        fs.chmodSync('mca', '777');
      }
      callback();
    }

    var config_default = {
      plugin_search_path: PLUGIN_SEARCH_PATH,
      lib: {
        android: {
          uri: path.join(mcaRoot, 'cordova', 'cordova-android'),
          version: "mca",
          id: "cordova-mca"
        },
        ios: {
          uri: path.join(mcaRoot, 'cordova', 'cordova-ios'),
          version: "mca",
          id: "cordova-mca"
        },
        www: {
          uri: srcAppDir,
          version: "mca",
          id: manifest.name
        }
      }
    };

    runCmd(cordova, ['create', destAppDir, appId, manifest.name, config_default], function(err) {
      if(err)
        return fatal(err);
      writeConfigStep(function(err) {
        if(err)
           return fatal(err);
        chdir(path.join(origDir, destAppDir));
        runAllCmds(cordova, cmds, afterAllCommands);
      });
    });
  }

  function writeConfigStep(callback) {
    console.log("Writing config.xml");
    fs.readFile(path.join(mcaRoot, 'templates', 'config.xml'), {encoding: 'utf-8'}, function(err, data) {
      if (err) {
        console.log(err);
      } else {
        var configfile = data.replace(/__APP_NAME__/, manifest.name)
            .replace(/__APP_ID__/, appId)
            .replace(/__APP_VERSION__/, (manifest.version) || "0.0.1")
            .replace(/__CHROME_APP_ID__/, chromeAppId)
            .replace(/__DESCRIPTION__/, (manifest.description) || "Plain text description of this app")
            .replace(/__AUTHOR__/, (manifest.author) || "Author name and email");
        fs.writeFile(path.join(destAppDir, 'config.xml'), configfile, callback);
      }
    });
  }

  function prepareStep(callback) {
    var welcomeText="\nCongratulations! Your project has been created at: "+
                    path.join(origDir,destAppDir)+"\n"+
                    "Be sure to edit only the copy of your application that is in the project www directory:\n"+
                    path.join(origDir, destAppDir, 'www')+" \n"+
                    "After any edits, remember to run 'mca prepare'\n"+
                    "This ensures that any changes are reflected in your mobile application projects\n";

    runCmd(cordova, ['prepare'], function(err) {
       if(err) {
          return fatal(err);
       }
       if(commandLineFlags.source) {
         console.log(welcomeText);
       }
       callback()
    });
  }

  eventQueue.push(validateSourceArgStep);
  eventQueue.push(readManifestStep);
  eventQueue.push(createStep);
  eventQueue.push(prepareStep);
}

/******************************************************************************/
/******************************************************************************/
// Update App

function prePrepareCommand() {
  var cordova = require('cordova');
  var plugins = [];

  /* Pre-create, pre-prepare manifest check and project munger */
  function readManifestStep(callback) {
    var manifestFile = path.join('www', 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
      return callback();
    }
    readManifest(manifestFile, function(manifest) {
      parseManifest(manifest, function(chromeAppId, whitelist, pluginsFromManifest) {
        plugins = pluginsFromManifest;
        console.log("Writing config.xml");
        fs.readFile('config.xml', {encoding: 'utf-8'}, function(err, data) {
          if (err) {
            console.log(err);
          } else {
            var tree = et.parse(data);

            var widget = tree.getroot();
            if (widget.tag == 'widget') {
              widget.attrib.version = manifest.version;
            }

            var name = tree.findall('./name');
            if (name.length) name[0].text = manifest.name;

            var description = tree.findall('./description');
            if (description.length) description[0].text = manifest.description;

            var author = tree.findall('./author');
            if (author.length) author[0].text = manifest.author;

            var content = tree.findall('./content');
            if (content.length) content[0].attrib.src = "chromeapp.html";

            var access = widget.findall('access');
            access.forEach(function(elem, index) {
              /* The useless '0' parameter here will be removed with elementtree 0.1.6 */
              widget.remove(0, elem);
            });
            whitelist.forEach(function(pattern, index) {
              var tag = et.SubElement(widget, 'access');
              tag.attrib.origin = pattern;
            });

            var configfile = et.tostring(tree.getroot(), {indent: 4});
            fs.writeFile('config.xml', configfile, callback);
          }
        });
      });
    });
  }

  function installPluginsStep(callback) {
    console.log("Updating plugins");
    var cmds = [];
    plugins.forEach(function(pluginPath) {
      cmds.push(['plugin', 'add', pluginPath]);
    });
    runAllCmds(cordova, cmds, callback);
  }

  eventQueue.push(readManifestStep);
  eventQueue.push(installPluginsStep);
}

function updateAppCommand() {
  var hasAndroid = fs.existsSync(path.join('platforms', 'android'));
  var hasIos = fs.existsSync(path.join('platforms', 'ios'));

  if (!fs.existsSync('platforms')) {
    fatal('No platforms directory found. Please run script from the root of your project.');
  }

  function assetDirForPlatform(platform) {
    if (platform === 'android') {
      return path.join('platforms', platform, 'assets','www');
    }
    return path.join('platforms', platform, 'www');
  }

  /* Android asset packager ignores, by default, directories beginning with
     underscores. This can be fixed with an update to the project.properties
     file, but only when compiling with ant. There is a bug outstanding to
     fix this behaviour in Eclipse/ADT as well.

     References:
       https://code.google.com/p/android/issues/detail?id=5343
       https://code.google.com/p/android/issues/detail?id=41237
   */
  function moveI18NMessagesDir(platform) {
    return function(callback) {
      var badPath = path.join(assetDirForPlatform(platform), '_locales');
      var betterPath = path.join(assetDirForPlatform(platform), 'MCA_locales');
      if (fs.existsSync(badPath)) {
        console.log('## Moving ' + platform + ' locales directory');
        fs.renameSync(badPath, betterPath);
        console.log('## Renaming directories inside locales');
        fs.readdir(betterPath,function(err, files) {
          if (!err) {
            for (var i=0; i<files.length; i++) {
              var fullName = path.join(betterPath, files[i]);
              var adjustedFilename= files[i].replace('-', '_').toLowerCase();
              if (files[i] !== adjustedFilename) {
                stats = fs.statSync(fullName);
                if (stats.isDirectory()) {
                  fs.renameSync(fullName, path.join(betterPath, adjustedFilename));
                }
              }
            }
          }
          callback();
        });
      } else {
        callback();
      }
    };
  }

  function copyIconAssetsStep(platform) {
    return function(callback) {
      readManifest('www/manifest.json', function(manifest) {
        if (manifest && manifest.icons) {
          var iconMap = {};
          if (platform === "android") {
            iconMap = {
              "36": [path.join('res','drawable-ldpi','icon.png')],
              "48": [path.join('res','drawable-mdpi','icon.png')],
              "72": [path.join('res','drawable-hdpi','icon.png')],
              "96": [path.join('res','drawable-xhdpi','icon.png'),
                     path.join('res','drawable','icon.png')],
            };
          } else if (platform === "ios") {
            var platforms = require('cordova/platforms');
            var parser = new platforms.ios.parser(path.join('platforms','ios'));
            iconMap = {
              "57": [path.join(parser.originalName, 'Resources','icons','icon.png')],
              "72": [path.join(parser.originalName, 'Resources','icons','icon-72.png')],
              "114": [path.join(parser.originalName, 'Resources','icons','icon@2x.png')],
              "144": [path.join(parser.originalName, 'Resources','icons','icon-72@2x.png')]
            };
          }
          if (iconMap) {
            //console.log('## Copying icons for ' + platform);
            for (size in iconMap) {
              if (manifest.icons[size]) {
                for (var i=0; i < iconMap[size].length; i++) {
                  //console.log("Copying " + size + "px icon file");
                  copyFile(path.join('www', manifest.icons[size]),
                           path.join('platforms', platform, iconMap[size][i]),
                           function(err) {
                             if (err) {
                               console.log("Error copying " + size + "px icon file");
                             }
                           });
                }
              } else {
                //console.log("No " + size + "px icon file declared");
              }
            }
          }
        }
        callback();
      });
    };
  }

  if (hasAndroid) {
    eventQueue.push(moveI18NMessagesDir('android'));
    eventQueue.push(copyIconAssetsStep('android'));
  }
  if (hasIos) {
    eventQueue.push(moveI18NMessagesDir('ios'));
    eventQueue.push(copyIconAssetsStep('ios'));
  }
}

/******************************************************************************/
/******************************************************************************/

function parseCommandLine() {
  commandLineFlags = optimist
      .usage('Usage: $0 command [commandArgs]\n' +
             '\n' +
             'Valid Commands:\n' +
             '\n' +
             'init - Ensures that your environment is setup correctly.\n' +
             '    Examples:\n' +
             '        mca init.\n' +
             '\n' +
             'create [--android] [--ios] [--source path] - Creates a new project.\n' +
             '    Flags:\n' +
             '        --android: Add the Android platform (default if android SDK is detected).\n' +
             '        --ios: Add the iOS platform (default if Xcode is detected).\n' +
             '        --source=path/to/chromeapp: Create a project based on the given chrome app.\n' +
             '    Examples:\n' +
             '        mca create org.chromium.Demo\n' +
             '        mca create org.chromium.Spec --android --source=chrome-cordova/spec/www\n' +
             'Cordova commands will be forwarded directly to cordova.\n' +
             '    Commands:\n' +
             '        build, compile, emulate, platform(s), plugin(s), prepare, run\n' +
             '    Examples:\n' +
             '        mca platform add ios\n' +
             '        mca build ios\n' +
             '    Run "cordova help" for details.\n'
      ).options('h', {
          alias: 'help',
          desc: 'Show usage message.'
      }).options('v', {
          alias: 'version',
          desc: 'Show version.'
      }).argv;

  if (commandLineFlags.v) {
    var package = require('../package');
    console.log(package.version);
    exit(0);
  }
  if (commandLineFlags.h || !commandLineFlags._[0] || commandLineFlags._[0] == 'help') {
    optimist.showHelp();
    exit(1);
  }
}

function main() {
  parseCommandLine();
  var command = commandLineFlags._[0];
  var appId = commandLineFlags._[1] || '';

  // Colorize after parseCommandLine to avoid --help being printed in red.
  colorizeConsole();

  var commandActions = {
    // Secret command used by our prepare hook.
    'pre-prepare': function() {
      prePrepareCommand();
    },
    'update-app': function() {
      updateAppCommand();
    },
    'init': function() {
      toolsCheck();
      initCommand();
    },
    'create': function() {
      ensureHasRunInit();
      if (isGitRepo) {
        promptIfNeedsGitUpdate();
      }
      toolsCheck();
      createCommand(appId, commandLineFlags.android, commandLineFlags.ios);
    },
  };

  // The following commands are forwarded to cordova with all args.
  var cordovaCommands = {
    'build': 1,
    'compile': 1,
    'emulate': 1,
    'platform': 1,
    'platforms': 1,
    'plugin': 1,
    'plugins': 1,
    'prepare': 1,
    'run': 1,
    'serve': 1
  };

  if (commandActions.hasOwnProperty(command)) {
    commandActions[command]();
    pump();
  } else if (cordovaCommands[command]) {
    console.log('Running cordova ' + command);
    // TODO (kamrik): to avoid this hackish require, add require('cli') in cordova.js
    var CLI = require('../node_modules/cordova/src/cli');
    new CLI(process.argv);
  } else {
    fatal('Invalid command: ' + command + '. Use --help for usage.');
  }
}

if (require.main === module) {
    main();
} else {
    module.exports = {
        parseCLI: main
    };
}
