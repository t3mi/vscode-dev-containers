/*--------------------------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://go.microsoft.com/fwlink/?linkid=2090316 for license information.
 *-------------------------------------------------------------------------------------------------------------*/

import * as asyncUtils from './async';
import { getFallbackPoolUrl, getPoolKeyForPoolUrl,snakeCaseToCamelCase, getDefaultDependencies, getConfig, 
    getLinuxPackageManagerForDistro, getPackageInfoExtractorParams, LinuxPackageInfoExtractorParams } from './config';
import { DependencyInfoExtractionSettings, DependencyInfoExtractionSettingsGroup, OtherDependencyInfoExtractionSettings, CgComponent } from '../domain/definition';
import { Lookup } from '../domain/common';

export interface PackageInfo {
    name: string;
    version: string;
    url?: string;
    path?: string;
    annotation?: string;
    poolUrl?: string;
    poolKeyUrl?: string;
    commitHash?: string;
    cgIgnore?: boolean;
    markdownIgnore?: boolean;
}

export interface ImageInfo {
    name: string;
    digest: string;
    user: string;
}

export interface DistroInfo extends Lookup<string | undefined> {
    prettyName: string;
    name: string;
    versionId: string;
    version: string;
    versionCodename: string;
    id: string;
    idLike?: string;
    homeUrl?: string;
    supportUrl?: string;
    bugReportUrl?: string;
}

export interface ExtractedInfo {
    image: ImageInfo;
    distro: DistroInfo,
    linux: PackageInfo[];
    npm: PackageInfo[];
    pip: PackageInfo[];
    pipx: PackageInfo[];
    gem: PackageInfo[];
    cargo: PackageInfo[];
    go: PackageInfo[];
    git: PackageInfo[];
    other: PackageInfo[];
    languages: PackageInfo[];
    manual: CgComponent[];
}

/* This function converts the contents of /etc/os-release from this:

    PRETTY_NAME="Debian GNU/Linux 10 (buster)"
    NAME="Debian GNU/Linux"
    VERSION_ID="10"
    VERSION="10 (buster)"
    VERSION_CODENAME=buster
    ID=debian
    HOME_URL="https://www.debian.org/"
    SUPPORT_URL="https://www.debian.org/support"
    BUG_REPORT_URL="https://bugs.debian.org/"

to an object like this:

{
    prettyName: "Debian GNU/Linux 10 (buster)"
    name: "Debian GNU/Linux"
    versionId: "10"
    version: "10 (buster)"
    versionCodename: buster
    id: debian
    homeUrl: "https://www.debian.org/"
    supportUrl: "https://www.debian.org/support"
    bugReportUrl: "https://bugs.debian.org/"
}
*/
async function getLinuxDistroInfo(imageTagOrContainerName: string): Promise<DistroInfo> {
    const info: Lookup<string> = {};
    const osInfoCommandOutput = await getCommandOutputFromContainer(imageTagOrContainerName, 'cat /etc/os-release', true);
    const osInfoLines = osInfoCommandOutput.split('\n');
    osInfoLines.forEach((infoLine) => {
        const infoLineParts = infoLine.split('=');
        if (infoLineParts.length === 2) {
            const propName = snakeCaseToCamelCase(infoLineParts[0].trim());
            info[propName] = infoLineParts[1].replace(/"/g, '').trim();
        }
    })
    return <DistroInfo>info;
}

/* A set of info objects linux packages. E.g.
{
    name: "yarn",
    version: "1.22.5-1",
    annotation: "Yarn"
    poolUrl: "https://dl.yarnpkg.com/debian",
    poolKeyUrl: "https://dl.yarnpkg.com/debian/pubkey.gpg"
}

Defaults to "cgIgnore": true, "markdownIgnore": false given base packages don't need to be registered
*/
async function getLinuxPackageInfo(imageTagOrContainerName: string, packageList: Array<string | DependencyInfoExtractionSettings> = [], linuxDistroInfo: DistroInfo): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const packageManager = getLinuxPackageManagerForDistro(linuxDistroInfo.id);
    const defaultPackages = getDefaultDependencies(packageManager) || [];
    packageList = defaultPackages.concat(packageList);

    // Return empty array if no packages
    if (packageList.length === 0) {
        return [];
    }

    // Get OS info if not passed in
    if (!linuxDistroInfo) {
        linuxDistroInfo = await getLinuxDistroInfo(imageTagOrContainerName);
    }

    // Generate a settings object from packageList
    const settings = packageList.reduce((obj: Lookup<DependencyInfoExtractionSettings>, current: string | DependencyInfoExtractionSettings) => {
        if (typeof current === 'string') {
            obj[current] = { name: current };
        } else {
            obj[current.name] = current;
        }
        return obj;
    }, <Lookup<DependencyInfoExtractionSettings>>{});

    // Space separated list of packages for use in commands
    const packageListCommandPart = packageList.reduce((prev: string, current: string | DependencyInfoExtractionSettings) => {
        return prev += ` ${typeof current === 'string' ? current : current.name}`;
    }, '');

    // Use the appropriate package lookup settings for distro
    const linuxPackageInfoExtractorParams: LinuxPackageInfoExtractorParams = getPackageInfoExtractorParams(packageManager);

    // Generate and exec command to get installed package versions
    console.log('(*) Gathering information about Linux package versions...');
    const packageVersionListOutput = await getCommandOutputFromContainer(imageTagOrContainerName,
        linuxPackageInfoExtractorParams.listCommand + packageListCommandPart + " || echo 'Some packages were not found.'", true);

    // Generate and exec command to extract download URIs
    console.log('(*) Gathering information about Linux package download URLs...');
    const packageUriCommandOutput = await getCommandOutputFromContainer(imageTagOrContainerName,
        linuxPackageInfoExtractorParams.getUriCommand + packageListCommandPart + " || echo 'Some packages were not found.'", true);

    const packageInfoList: PackageInfo[] = [];
    const packageVersionList = packageVersionListOutput.split('\n');
    packageVersionList.forEach((packageVersion: string) => {
        packageVersion = packageVersion.trim();
        if (packageVersion !== '') {
            const versionCaptureGroup = new RegExp(linuxPackageInfoExtractorParams.lineRegEx).exec(packageVersion);
            if (!versionCaptureGroup) {
                if (packageVersion === 'Some packages were not found.') {
                    console.log('(!) Warning: Some specified packages were not found.');
                } else {
                    console.log(`(!) Warning: Unable to parse output "${packageVersion}" - skipping.`);
                }
                return;
            }
            const [, packageName, version] = versionCaptureGroup;
            const extractionSettings = <DependencyInfoExtractionSettings>(settings[packageName] || {});
            const cgIgnore = typeof extractionSettings.cgIgnore === 'undefined' ? true : extractionSettings.cgIgnore; // default to true
            const poolUrl = getPoolUrlFromPackageVersionListOutput(packageUriCommandOutput, linuxPackageInfoExtractorParams, packageName, version);
            const poolKey = poolUrl ? getPoolKeyForPoolUrl(poolUrl) : undefined;
            if (!poolUrl && !cgIgnore) {
                throw new Error('(!) No pool URL found to register package!');
            }
            packageInfoList.push({
                name: packageName,
                version: version,
                poolUrl: poolUrl,
                poolKeyUrl: poolKey,
                annotation: extractionSettings.annotation,
                cgIgnore: cgIgnore,
                markdownIgnore: extractionSettings.markdownIgnore
            } as PackageInfo);
        }
    });

    return packageInfoList;
}

// Gets a package pool URL out of a download URL - Needed for registering in cgmanifest.json
function getPoolUrlFromPackageVersionListOutput(packageUriCommandOutput: string, config: LinuxPackageInfoExtractorParams, packageName: string, version: string) {
    // Handle regex reserved charters in regex strings and that ":" is treaded as "1%3a" on Debian/Ubuntu 
    const sanitizedPackage = packageName.replace(/\+/g, '\\+').replace(/\./g, '\\.');
    const sanitizedVersion = version.replace(/\+/g, '\\+').replace(/\./g, '\\.').replace(/:/g, '%3a');
    const uriCaptureGroup = new RegExp(
        config.poolUriMatchRegEx.replace('${PACKAGE}', sanitizedPackage).replace('${VERSION}', sanitizedVersion), 'm')
        .exec(packageUriCommandOutput);

    if (!uriCaptureGroup) {
        const fallbackPoolUrl = getFallbackPoolUrl(packageName);
        if (fallbackPoolUrl) {
            return fallbackPoolUrl;
        }
        console.log(`(!) No URI found for ${packageName} ${version}.`);
        return undefined;
    }

    // Extract URIs
    return uriCaptureGroup[1];
}

/* Generate "Npm" info objects. E.g.
{
    name: "eslint",
    version: "7.23.0"
}
*/
async function getNpmGlobalPackageInfo(imageTagOrContainerName: string, packageNameList: string[] = []): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies('npm') || [];
    packageNameList = defaultPackages.concat(packageNameList);

    // Return empty array if no packages
    if (packageNameList.length === 0) {
        return [];
    }

    console.log(`(*) Gathering information about globally installed npm packages...`);

    const packageListString = packageNameList.reduce((prev, current) => prev + ' ' + current, '');
    const npmOutputRaw = await getCommandOutputFromContainer(imageTagOrContainerName, `bash -l -c 'set -e && npm ls --global --depth 1 --json ${packageListString}' 2>/dev/null`);
    const npmOutput = JSON.parse(npmOutputRaw);

    return packageNameList.map((packageName) => {
        let packageJson = npmOutput.dependencies[packageName];
        if (!packageJson) {
            // Possible desired package is referenced by another top level package, so check dependencies too.
            // E.g. tslint-to-eslint-config can cause typescript to not appear at top level in npm ls
            for (let packageInNpmOutput in npmOutput.dependencies) {
                const packageDependencies = npmOutput.dependencies[packageInNpmOutput].dependencies;
                if (packageDependencies) {
                    packageJson = packageDependencies[packageName];
                    if (packageJson) {
                        break;
                    }
                }
            }
        }
        if (!packageJson || !packageJson.version) {
            throw new Error(`Unable to parse version for ${packageName} from npm ls output: ${npmOutputRaw}`);
        }
        return {
            name: packageName,
            version: packageJson.version
        }
    });
}


/* Generate pip or pipx info objects. E.g.
{
    name: "pylint",
    version: "2.6.0"
}
*/
async function getPipPackageInfo(imageTagOrContainerName: string, packageNameList: string[] = [], usePipx: boolean): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies(usePipx ? 'pipx' : 'pip') || [];
    packageNameList = defaultPackages.concat(packageNameList);

    // Return empty array if no packages
    if (packageNameList.length === 0) {
        return [];
    }

    // Generate and exec command to get installed package versions
    console.log('(*) Gathering information about pip packages...');
    const versionLookup = usePipx ? await getPipxVersionLookup(imageTagOrContainerName) : await getPipVersionLookup(imageTagOrContainerName);

    return packageNameList.map((packageName) => {
        return {
            name: packageName,
            version: versionLookup[packageName]
        };
    });
}

async function getPipVersionLookup(imageTagOrContainerName: string) {
    const packageVersionListOutput = await getCommandOutputFromContainer(imageTagOrContainerName, 'pip list --format json');

    const packageVersionList = JSON.parse(packageVersionListOutput);

    return packageVersionList.reduce((prev: Lookup<any>, current: any) => {
        prev[current.name] = current.version;
        return prev;
    }, <Lookup<any>>{});
}

async function getPipxVersionLookup(imageTagOrContainerName: string) {
    // --format json doesn't work with pipx, so have to do text parsing
    const packageVersionListOutput = await getCommandOutputFromContainer(imageTagOrContainerName, 'pipx list');

    const packageVersionListOutputLines = packageVersionListOutput.split('\n');
    return packageVersionListOutputLines.reduce((prev: Lookup<string>, current: string) => {
        const versionCaptureGroup = /package\s(.+)\s(.+),/.exec(current);
        if (versionCaptureGroup) {
            prev[versionCaptureGroup[1]] = versionCaptureGroup[2];
        }
        return prev;
    }, <Lookup<string>>{});
}

/* Generate git info objects. E.g.
{
    name: "Oh My Zsh!",
    path: "/home/codespace/.oh-my-zsh",
    repositoryUrl: "https://github.com/ohmyzsh/ohmyzsh.git",
    commitHash: "cddac7177abc358f44efb469af43191922273705"
}
*/
async function getGitRepositoryInfo(imageTagOrContainerName: string, gitRepos: Lookup<string> = {}): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies('git');
    if (defaultPackages) {
        const merged = defaultPackages;
        for (let otherName in gitRepos) {
            merged[otherName] = gitRepos[otherName];
        }
        gitRepos = merged;
    }
    // Return empty array if no components
    if (!gitRepos) {
        return [];
    }

    const packageInfoList: PackageInfo[] = [];
    for (let repoName in gitRepos) {
        const repoPath = gitRepos[repoName];
        if (typeof repoPath === 'string') {
            console.log(`(*) Getting remote and commit for ${repoName} at ${repoPath}...`);
            // Go to the specified folder, see if the commands have already been run, if not run them and get output
            const remoteAndCommitOutput = await getCommandOutputFromContainer(imageTagOrContainerName, `cd \\"${repoPath}\\" && if [ -f \\".git-remote-and-commit\\" ]; then cat .git-remote-and-commit; else git remote get-url origin && git log -n 1 --pretty=format:%H -- . | tee /dev/null; fi`, true);
            const [gitRemote, gitCommit] = remoteAndCommitOutput.split('\n');
            if (!gitRemote || !gitCommit) {
                throw new Error(`Unable to determine git remote or commit for ${repoName}.`);
            }
            packageInfoList.push({
                name: repoName,
                path: repoPath,
                url: gitRemote,
                commitHash: gitCommit
            } as PackageInfo);
        }
    }

    return packageInfoList;
}

/* Generate "other" info objects. E.g.
{
    name: "Xdebug",
    version: "2.9.6",
    downloadUrl: "https://pecl.php.net/get/xdebug-2.9.6.tgz"
}
*/
async function getOtherDependencyInfo(imageTagOrContainerName: string, otherDependencyList: Lookup<OtherDependencyInfoExtractionSettings | null> = {}, otherType: string = 'other'): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies(otherType);
    if (defaultPackages) {
        const merged = defaultPackages;
        for (let otherName in otherDependencyList) {
            merged[otherName] = otherDependencyList[otherName];
        }
        otherDependencyList = merged;
    }
    // Return empty array if no components
    if (!otherDependencyList) {
        return [];
    }

    console.log(`(*) Gathering information about "other" components...`);
    const packageInfoList: PackageInfo[] = [];
    for (let otherName in otherDependencyList) {
        const otherSettings: OtherDependencyInfoExtractionSettings = mergeOtherDefaultSettings(otherName, otherDependencyList[otherName]);
        if (typeof otherSettings === 'object') {
            console.log(`(*) Getting version for ${otherName}...`);
            // Run specified command to get the version number
            if (!otherSettings.versionCommand) {
                throw new Error(`Missing versionCommand for ${otherName}.`)
            }
            const otherVersion = await getCommandOutputFromContainer(imageTagOrContainerName, otherSettings.versionCommand);
            packageInfoList.push({
                name: otherName,
                version: otherVersion,
                url: otherSettings.downloadUrl,
                path: otherSettings.path,
                annotation: otherSettings.annotation,
                cgIgnore: otherSettings.cgIgnore,
                markdownIgnore: otherSettings.markdownIgnore
            } as PackageInfo);
        }
    }

    return packageInfoList;
}

// Merge in default config for specified otherName if it exists
function mergeOtherDefaultSettings(otherName: string, dependency: OtherDependencyInfoExtractionSettings | null): OtherDependencyInfoExtractionSettings {
    const otherDefaultSettings = getConfig('otherDependencyDefaultSettings', null);
    if (!otherDefaultSettings || !otherDefaultSettings[otherName]) {
        if (!dependency) {
            throw new Error(`No extraction settings found for ${otherName}.`)
        }
        return dependency;
    }
    // Create a copy of default settings for merging
    const mergedSettings = <OtherDependencyInfoExtractionSettings>Object.assign({}, otherDefaultSettings[otherName]);
    if (dependency) {
        for (let settingName in dependency) {
            (<any>mergedSettings)[settingName] = (<any>dependency)[settingName];
        }
    }
    return mergedSettings;
}

/* Generate Ruby gems info objects. E.g.
{
    name: "rake",
    version: "13.0.1"
}
*/
async function getGemPackageInfo(imageTagOrContainerName: string, packageList: string[] = []): Promise<PackageInfo[]> {
    // Merge in default dependencies
    packageList = packageList || [];
    const defaultPackages = getDefaultDependencies('gem') || [];
    packageList = defaultPackages.concat(packageList);

    // Return empty array if no packages
    if (packageList.length === 0) {
        return [];
    }

    console.log(`(*) Gathering information about gems...`);
    const gemListOutput = await getCommandOutputFromContainer(imageTagOrContainerName, "bash -l -c 'set -e && gem list -d --local' 2>/dev/null");
    return packageList.map((gem) => {
        const gemVersionCaptureGroup = new RegExp(`^${gem}\\s\\(([^\\),]+)`, 'm').exec(gemListOutput);
        if (!gemVersionCaptureGroup) {
            throw new Error(`Could not extract information about gem ${gem}`);
        }
        const gemVersion = gemVersionCaptureGroup[1];
        return {
            name: gem,
            version: gemVersion
        }
    });
}

/* Generate cargo info object. E.g.
{
    name: "rustfmt",
    version: "1.4.17-stable"
}
*/
async function getCargoPackageInfo(imageTagOrContainerName: string, cargoPackages: Lookup<string | null> = {}): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies('go');
    if (defaultPackages) {
        const merged = defaultPackages;
        for (let packageName in cargoPackages) {
            merged[packageName] = cargoPackages[packageName];
        }
        cargoPackages = merged;
    }
    // Return empty array if no packages
    if (!cargoPackages) {
        return [];
    }

    const packageInfoList:PackageInfo[] = [];
    console.log(`(*) Gathering information about cargo packages...`);

    for (let crate in cargoPackages) {
        if (typeof crate === 'string') {
            const versionCommand = cargoPackages[crate] || `${crate} --version`;
            console.log(`(*) Getting version for ${crate}...`);
            const versionOutput = await getCommandOutputFromContainer(imageTagOrContainerName, versionCommand);
            const crateVersionCaptureGroup = new RegExp('[0-9]+\\.[0-9]+\\.[0-9]+', 'm').exec(versionOutput);
            if (!crateVersionCaptureGroup) {
                throw new Error(`Could not extract information about crate ${crate}`);
            }
            const version = crateVersionCaptureGroup[0];
            packageInfoList.push({
                name: crate,
                version: version
            });
        }
    }

    return packageInfoList;
}

/* Generate go info objects. E.g.
{
    name: "golang.org/x/tools/gopls",
    version: "0.6.4"
}
*/
async function getGoPackageInfo(imageTagOrContainerName: string, goPackages: Lookup<string | null> = {}): Promise<PackageInfo[]> {
    // Merge in default dependencies
    const defaultPackages = getDefaultDependencies('go');
    if (defaultPackages) {
        const merged = defaultPackages;
        for (let packageName in goPackages) {
            merged[packageName] = goPackages[packageName];
        }
        goPackages = merged;
    }
    // Return empty array if no components
    if (!goPackages) {
        return [];
    }

    console.log(`(*) Gathering information about go modules and packages...`);
    const packageInfoList:PackageInfo[] = [];
    const packageInstallOutput = await getCommandOutputFromContainer(imageTagOrContainerName, "cat /usr/local/etc/vscode-dev-containers/go.log");
    for (let packageName in goPackages) {
        if (typeof packageName === 'string') {
            const versionCommand = goPackages[packageName];
            let version;
            if (versionCommand) {
                version = await getCommandOutputFromContainer(imageTagOrContainerName, versionCommand);
            } else {
                const versionCaptureGroup = new RegExp(`downloading\\s*${packageName}\\s*v([0-9]+\\.[0-9]+\\.[0-9]+.*)\\n`).exec(packageInstallOutput);
                version = versionCaptureGroup ? versionCaptureGroup[1] : 'latest';
            }
            packageInfoList.push({
                name: packageName,
                version: version
            });
        }
    }

    return packageInfoList;
}

/* Generate image info object. E.g.
{
    "name": "debian"
    "digest": "sha256:c33d4c1938625a1d0cda78102127b81935e0e94785bc4810b71b5f236dd935e"
}
*/
async function getImageInfo(imageTagOrContainerName: string): Promise<ImageInfo> {
    let image = imageTagOrContainerName;
    if (isContainerName(imageTagOrContainerName)) {
        image = await asyncUtils.spawn('docker', ['inspect', "--format='{{.Image}}'", imageTagOrContainerName.trim()], { shell: true, stdio: 'pipe' });
    }
    // If image not yet published, there will be no repo digests, so set to N/A if that is the case
    let name: string, digest: string;
    try {
        const imageNameAndDigest = await asyncUtils.spawn('docker', ['inspect', "--format='{{index .RepoDigests 0}}'", image], { shell: true, stdio: 'pipe' });
        [name, digest] = imageNameAndDigest.trim().split('@');
    } catch (err: any) {
        if (err.result.indexOf('Template parsing error') > 0) {
            name = 'N/A';
            digest = 'N/A';
        } else {
            throw err;
        }
    }

    const nonRootUser = await getCommandOutputFromContainer(imageTagOrContainerName, 'id -un 1000', true)
    return {
        "name": name,
        "digest": digest,
        "user": nonRootUser
    }
}


// Command to start a container for processing. Returns a container name with a 
// specific format that can be used to detect whether an image tag or container
// name is passed into the content extractor functions.
async function startContainerForProcessing(imageTag: string) {
    const containerName = `vscdc--extract--${Date.now()}`;
    await asyncUtils.spawn('docker', ['run', '-d', '--rm', '--init', '--privileged', '--name', containerName, imageTag, 'sh -c "while sleep 1000; do :; done"'], { shell: true, stdio: 'inherit' });
    return containerName;
}

// Removes the specified container
async function removeProcessingContainer(containerName: string): Promise<void> {
    await asyncUtils.spawn('docker', ['rm', '-f', containerName], { shell: true, stdio: 'inherit' });
}

// Utility that executes commands inside a container. If a specially formatted container 
// name is passed in, the function will use "docker exec" and otherwise use "docker run" 
// since this means an image tag was passed in instead.
async function getCommandOutputFromContainer(imageTagOrContainerName: string, command: string, forceRoot: boolean = false): Promise<string> {
    const runArgs = isContainerName(imageTagOrContainerName) ?
        ['exec'].concat(forceRoot ? ['-u', 'root'] : [])
        : ['run', '--init', '--privileged', '--rm'].concat(forceRoot ? ['-u', 'root'] : []);
    const wrappedCommand = `bash -c "set -e && echo ~~~BEGIN~~~ && ${command} && echo && echo ~~~END~~~"`;
    runArgs.push(imageTagOrContainerName);
    runArgs.push(wrappedCommand);
    const result = await asyncUtils.spawn('docker', runArgs, { shell: true, stdio: 'pipe' });
    // Filter out noise from ENTRYPOINT output
    const filteredResult = result.substring(result.indexOf('~~~BEGIN~~~') + 11, result.indexOf('~~~END~~~'));
    return filteredResult.trim();
}

function isContainerName(imageTagOrContainerName: string) {
    return (imageTagOrContainerName.indexOf('vscdc--extract--') === 0)
}

// Return dependencies by mapping distro "ID" from /etc/os-release to determine appropriate package manger
function getLinuxPackageManagerDependencies(dependencies: DependencyInfoExtractionSettingsGroup, distroInfo: DistroInfo): (string | DependencyInfoExtractionSettings)[] {
    if ((<any>dependencies)[distroInfo.id]) {
        return (<any>dependencies)[distroInfo.id];
    }
    const packageManagerDependencies = (<any>dependencies)[getLinuxPackageManagerForDistro(distroInfo.id)];
    return packageManagerDependencies || [];
}

// Spins up a container for a referenced image and extracts info for the specified dependencies
export async function getAllContentInfo(imageTag: string, dependencies: DependencyInfoExtractionSettingsGroup): Promise<ExtractedInfo> {
    const containerName = await startContainerForProcessing(imageTag);
    try {
        const distroInfo = await getLinuxDistroInfo(containerName);
        const contents = {
            image: await getImageInfo(containerName),
            distro: distroInfo,
            linux: await getLinuxPackageInfo(containerName, getLinuxPackageManagerDependencies(dependencies, distroInfo), distroInfo),
            npm: await getNpmGlobalPackageInfo(containerName, dependencies.npm),
            pip: await getPipPackageInfo(containerName, dependencies.pip, false),
            pipx: await getPipPackageInfo(containerName, dependencies.pipx, true),
            gem: await getGemPackageInfo(containerName, dependencies.gem),
            cargo: await getCargoPackageInfo(containerName, dependencies.cargo),
            go: await getGoPackageInfo(containerName, dependencies.go),
            git: await getGitRepositoryInfo(containerName, dependencies.git),
            other: await getOtherDependencyInfo(containerName, dependencies.other, 'other'),
            languages: await getOtherDependencyInfo(containerName, dependencies.languages, 'languages'),
            manual: dependencies.manual
        } as ExtractedInfo;
        await removeProcessingContainer(containerName);
        return contents;
    } catch (e) {
        await removeProcessingContainer(containerName);
        throw e;
    }
}