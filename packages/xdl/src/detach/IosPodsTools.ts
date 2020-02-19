import fs from 'fs-extra';
import glob from 'glob-promise';
// @ts-ignore
import indentString from 'indent-string';
import JsonFile from '@expo/json-file';
import path from 'path';

import { parseSdkMajorVersion } from './ExponentTools';

function _validatePodfileSubstitutions(substitutions: { [key: string]: any }): true {
  const validKeys = [
    // a pod dependency on ExpoKit (can be local or remote)
    'EXPOKIT_DEPENDENCY',
    // local path to ExpoKit dependency
    'EXPOKIT_PATH',
    // tag to use for ExpoKit dependency
    'EXPOKIT_TAG',
    // the contents of dependencies.json enumerated as deps in podfile format
    'EXPONENT_CLIENT_DEPS',
    // postinstall for detached projects (defines EX_DETACHED among other things)
    'PODFILE_DETACHED_POSTINSTALL',
    // same as previous but also defines EX_DETACHED_SERVICE
    'PODFILE_DETACHED_SERVICE_POSTINSTALL',
    // ExponentIntegrationTests
    'PODFILE_TEST_TARGET',
    // unversioned react native pod dependency, probably at the path given in
    // REACT_NATIVE_PATH, with a bunch of subspecs.
    'PODFILE_UNVERSIONED_RN_DEPENDENCY',
    // postinstall hook for unversioned deps
    'PODFILE_UNVERSIONED_POSTINSTALL',
    // versioned rn dependencies (paths to versioned-react-native directories)
    // read from template files
    'PODFILE_VERSIONED_RN_DEPENDENCIES',
    // versioned rn postinstall hooks read from template files
    'PODFILE_VERSIONED_POSTINSTALLS',
    // list of generated Expo subspecs to include under a versioned react native dependency
    'REACT_NATIVE_EXPO_SUBSPECS',
    // path to use for the unversioned react native dependency
    'REACT_NATIVE_PATH',
    // name of the main build target, e.g. Exponent
    'TARGET_NAME',
    // path from Podfile to versioned-react-native
    'VERSIONED_REACT_NATIVE_PATH',
    // Expo universal modules dependencies
    'PODFILE_UNVERSIONED_EXPO_MODULES_DEPENDENCIES',
    // Universal modules configurations to be included in the Podfile
    'UNIVERSAL_MODULES',
    // Relative path from iOS project directory to folder where unimodules are installed.
    'UNIVERSAL_MODULES_PATH',
  ];

  for (const key in substitutions) {
    if (substitutions.hasOwnProperty(key)) {
      if (!validKeys.includes(key)) {
        throw new Error(`Unrecognized Podfile template key: ${key}`);
      }
    }
  }
  return true;
}

function _renderExpoKitDependency(
  options: { expoKitPath?: string; expoKitTag?: string },
  sdkVersion: string
): string {
  const sdkMajorVersion = parseSdkMajorVersion(sdkVersion);
  let attributes: { [key: string]: string | boolean | string[] };
  if (options.expoKitPath) {
    attributes = {
      path: options.expoKitPath,
    };
  } else if (options.expoKitTag) {
    attributes = {
      git: 'http://github.com/expo/expo.git',
      tag: options.expoKitTag,
    };
  } else {
    attributes = {
      git: 'http://github.com/expo/expo.git',
      branch: 'master',
    };
  }

  // GL subspec is available as of SDK 26
  // but removed together with CPP subspec in SDK 29
  if (sdkMajorVersion < 26) {
    attributes.subspecs = ['Core', 'CPP'];
  } else if (sdkMajorVersion < 29 && !process.env.EXPO_UNIVERSE_DIR) {
    attributes.subspecs = ['Core', 'CPP', 'GL'];
  } else {
    attributes.subspecs = ['Core'];
  }
  attributes.inhibit_warnings = true;

  let dependency = `pod 'ExpoKit',
${indentString(_renderDependencyAttributes(attributes), 2)}`;

  return indentString(dependency, 2);
}

/**
 * @param sdkVersion if specified, indicates which sdkVersion this project uses
 *  as 'UNVERSIONED', e.g. if we are detaching a sdk15 project, we render
 *  an unversioned dependency pointing at RN#sdk-15.
 */
function _renderUnversionedReactNativeDependency(
  options: { reactNativePath?: string },
  sdkVersion: string
): string {
  let sdkMajorVersion = parseSdkMajorVersion(sdkVersion);

  if (sdkMajorVersion >= 36) {
    return indentString(
      `
# Install React Native and its dependencies
require_relative '../node_modules/react-native/scripts/autolink-ios.rb'
use_react_native!`
    );
  }

  const glogLibraryName = sdkMajorVersion < 26 ? 'GLog' : 'glog';
  return indentString(
    `
${_renderUnversionedReactDependency(options)}
${_renderUnversionedYogaDependency(options)}
${_renderUnversionedThirdPartyDependency(
  'DoubleConversion',
  path.join('third-party-podspecs', 'DoubleConversion.podspec'),
  options
)}
${_renderUnversionedThirdPartyDependency(
  'Folly',
  path.join('third-party-podspecs', 'Folly.podspec'),
  options
)}
${_renderUnversionedThirdPartyDependency(
  glogLibraryName,
  path.join('third-party-podspecs', `${glogLibraryName}.podspec`),
  options
)}
`,
    2
  );
}

function _renderUnversionedReactDependency(
  options: { reactNativePath?: string },
  sdkVersion?: string
): string {
  if (!options.reactNativePath) {
    throw new Error(`Unsupported options for RN dependency: ${options}`);
  }
  let attributes = {
    path: options.reactNativePath,
    inhibit_warnings: true,
    subspecs: [
      'Core',
      'ART',
      'RCTActionSheet',
      'RCTAnimation',
      'RCTCameraRoll',
      'RCTGeolocation',
      'RCTImage',
      'RCTNetwork',
      'RCTText',
      'RCTVibration',
      'RCTWebSocket',
      'DevSupport',
      'CxxBridge',
    ],
  };
  return `pod 'React',
${indentString(_renderDependencyAttributes(attributes), 2)}`;
}

function _renderUnversionedYogaDependency(options: { reactNativePath?: string }): string {
  let attributes;
  if (options.reactNativePath) {
    attributes = {
      path: path.join(options.reactNativePath, 'ReactCommon', 'yoga'),
      inhibit_warnings: true,
    };
  } else {
    throw new Error(`Unsupported options for Yoga dependency: ${options}`);
  }
  return `pod 'yoga',
${indentString(_renderDependencyAttributes(attributes), 2)}`;
}

function _renderUnversionedThirdPartyDependency(
  podName: string,
  podspecRelativePath: string,
  options: { reactNativePath?: string }
): string {
  let attributes;
  if (options.reactNativePath) {
    attributes = {
      podspec: path.join(options.reactNativePath, podspecRelativePath),
      inhibit_warnings: true,
    };
  } else {
    throw new Error(`Unsupported options for ${podName} dependency: ${options}`);
  }
  return `pod '${podName}',
${indentString(_renderDependencyAttributes(attributes), 2)}`;
}

function _renderDependencyAttributes(attributes: { [key: string]: any }): string {
  let attributesStrings = [];
  for (let key of Object.keys(attributes)) {
    let value = JSON.stringify(attributes[key], null, 2);
    attributesStrings.push(`:${key} => ${value}`);
  }
  return attributesStrings.join(',\n');
}

function createSdkFilterFn(sdkVersion: any): undefined | ((i: string) => boolean) {
  if (sdkVersion && String(sdkVersion).toUpperCase() === 'UNVERSIONED') {
    return () => false;
  }
  if (sdkVersion === undefined || !sdkVersion.match(/^\d+\.\d+.\d+$/)) {
    return;
  }
  const sdkVersionWithUnderscores = sdkVersion.replace(/\./g, '_');
  return (i: string): boolean => i.endsWith(`/ReactABI${sdkVersionWithUnderscores}.rb`);
}

async function _renderVersionedReactNativeDependenciesAsync(
  templatesDirectory: string,
  versionedReactNativePath: string,
  expoSubspecs: string[],
  shellAppSdkVersion: any
): Promise<string> {
  const filterFn = createSdkFilterFn(shellAppSdkVersion);
  let result = await _concatTemplateFilesInDirectoryAsync(
    path.join(templatesDirectory, 'versioned-react-native', 'dependencies'),
    filterFn
  );
  const expoSubspecsString = expoSubspecs.map(subspec => `'${subspec}'`).join(', ');
  result = result.replace(/\$\{VERSIONED_REACT_NATIVE_PATH\}/g, versionedReactNativePath);
  result = result.replace(/\$\{REACT_NATIVE_EXPO_SUBSPECS\}/g, expoSubspecsString);
  return result;
}

async function _renderVersionedReactNativePostinstallsAsync(
  templatesDirectory: string,
  shellAppSdkVersion: any
): Promise<string> {
  const filterFn = createSdkFilterFn(shellAppSdkVersion);
  return _concatTemplateFilesInDirectoryAsync(
    path.join(templatesDirectory, 'versioned-react-native', 'postinstalls'),
    filterFn
  );
}

async function _concatTemplateFilesInDirectoryAsync(
  directory: string,
  filterFn: any
): Promise<string> {
  let templateFilenames = (await glob(path.join(directory, '*.rb'))).sort();
  let filteredTemplateFilenames = filterFn ? templateFilenames.filter(filterFn) : templateFilenames;
  let templateStrings = [];
  // perform this in series in order to get deterministic output
  for (let fileIdx = 0, nFiles = filteredTemplateFilenames.length; fileIdx < nFiles; fileIdx++) {
    const filename = filteredTemplateFilenames[fileIdx];
    let templateString = await fs.readFile(filename, 'utf8');
    if (templateString) {
      templateStrings.push(templateString);
    }
  }
  return templateStrings.join('\n');
}

function _renderDetachedPostinstall(sdkVersion: string, isServiceContext: boolean): string {
  const sdkMajorVersion = parseSdkMajorVersion(sdkVersion);
  const podNameExpression = sdkMajorVersion < 33 ? 'target.pod_name' : 'pod_name';
  const targetExpression = sdkMajorVersion < 33 ? 'target' : 'target_installation_result';

  let podsRootSub = '${PODS_ROOT}';
  const maybeDetachedServiceDef = isServiceContext
    ? `config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'EX_DETACHED_SERVICE=1'`
    : '';

  const maybeFrameworkSearchPathDef =
    sdkMajorVersion < 33
      ? `
          # Needed for GoogleMaps 2.x
          config.build_settings['FRAMEWORK_SEARCH_PATHS'] ||= []
          config.build_settings['FRAMEWORK_SEARCH_PATHS'] << '${podsRootSub}/GoogleMaps/Base/Frameworks'
          config.build_settings['FRAMEWORK_SEARCH_PATHS'] << '${podsRootSub}/GoogleMaps/Maps/Frameworks'`
      : '';
  return `
      if ${podNameExpression} == 'ExpoKit'
        ${targetExpression}.native_target.build_configurations.each do |config|
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'EX_DETACHED=1'
          ${maybeDetachedServiceDef}
          # Enable Google Maps support
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'HAVE_GOOGLE_MAPS=1'
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'HAVE_GOOGLE_MAPS_UTILS=1'
          ${maybeFrameworkSearchPathDef}
        end
      end
`;
}

function _renderUnversionedPostinstall(sdkVersion: string): string {
  const podsToChangeDeployTarget = [
    'Amplitude-iOS',
    'Analytics',
    'AppAuth',
    'Branch',
    'CocoaLumberjack',
    'FBSDKCoreKit',
    'FBSDKLoginKit',
    'FBSDKShareKit',
    'GPUImage',
    'JKBigInteger2',
  ];
  const podsToChangeRB = `[${podsToChangeDeployTarget.map(pod => `'${pod}'`).join(',')}]`;
  const sdkMajorVersion = parseSdkMajorVersion(sdkVersion);
  const podNameExpression = sdkMajorVersion < 33 ? 'target.pod_name' : 'pod_name';
  const targetExpression = sdkMajorVersion < 33 ? 'target' : 'target_installation_result';

  // SDK31 drops support for iOS 9.0
  const deploymentTarget = sdkMajorVersion > 30 ? '10.0' : '9.0';

  const podsToChangeDeployTargetIfStart =
    sdkMajorVersion <= 33 ? `      if ${podsToChangeRB}.include? ${podNameExpression}` : '';
  const podsToChangeDeployTargetIfEnd = sdkMajorVersion <= 33 ? '      end' : '';
  const gccPreprocessorDefinitionsCondition =
    sdkMajorVersion < 36
      ? `${podNameExpression} == 'React'`
      : `${podNameExpression}.start_with?('React')`;

  return `
${podsToChangeDeployTargetIfStart}
      ${targetExpression}.native_target.build_configurations.each do |config|
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${deploymentTarget}'
      end
${podsToChangeDeployTargetIfEnd}

      # Can't specify this in the React podspec because we need to use those podspecs for detached
      # projects which don't reference ExponentCPP.
      if ${podNameExpression}.start_with?('React')
        ${targetExpression}.native_target.build_configurations.each do |config|
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${deploymentTarget}'
          config.build_settings['HEADER_SEARCH_PATHS'] ||= ['$(inherited)']
        end
      end

      # Build React Native with RCT_DEV enabled and RCT_ENABLE_INSPECTOR and
      # RCT_ENABLE_PACKAGER_CONNECTION disabled
      next unless ${gccPreprocessorDefinitionsCondition}
      ${targetExpression}.native_target.build_configurations.each do |config|
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'RCT_DEV=1'
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'RCT_ENABLE_INSPECTOR=0'
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'ENABLE_PACKAGER_CONNECTION=0'
      end
`;
}

function _renderTestTarget(reactNativePath?: string): string {
  return `
  target 'ExponentIntegrationTests' do
    inherit! :search_paths
  end

  target 'Tests' do
    inherit! :search_paths
  end
`;
}

async function _renderPodDependenciesAsync(
  dependenciesConfigPath: string,
  options: { isPodfile?: boolean }
): Promise<string> {
  let dependencies = await new JsonFile(dependenciesConfigPath).readAsync();
  const type = options.isPodfile ? 'pod' : 'ss.dependency';
  const noWarningsFlag = options.isPodfile ? `, :inhibit_warnings => true` : '';
  let depsStrings: string[] = [];
  if (Array.isArray(dependencies)) {
    depsStrings = dependencies.map(dependency => {
      let builder = '';
      if (dependency.comments) {
        builder += dependency.comments
          .map((commentLine: string) => `  # ${commentLine}`)
          .join('\n');
        builder += '\n';
      }
      const otherPodfileFlags = options.isPodfile && dependency.otherPodfileFlags;
      builder += `  ${type} '${dependency.name}', '${
        dependency.version
      }'${noWarningsFlag}${otherPodfileFlags || ''}`;
      return builder;
    });
  }
  return depsStrings.join('\n');
}

export async function renderExpoKitPodspecAsync(
  pathToTemplate: string,
  pathToOutput: string,
  moreSubstitutions: { [key: string]: any }
): Promise<void> {
  let templatesDirectory = path.dirname(pathToTemplate);
  let templateString = await fs.readFile(pathToTemplate, 'utf8');
  let dependencies = await _renderPodDependenciesAsync(
    path.join(templatesDirectory, 'dependencies.json'),
    { isPodfile: false }
  );
  let result = templateString.replace(/\$\{IOS_EXPOKIT_DEPS\}/g, indentString(dependencies, 2));
  if (moreSubstitutions && moreSubstitutions.IOS_EXPONENT_CLIENT_VERSION) {
    result = result.replace(
      /\$\{IOS_EXPONENT_CLIENT_VERSION\}/g,
      moreSubstitutions.IOS_EXPONENT_CLIENT_VERSION
    );
  }

  await fs.writeFile(pathToOutput, result);
}

function _renderUnversionedUniversalModulesDependencies(
  universalModules: { podName: string; path: string }[],
  universalModulesPath: string,
  sdkVersion: string
): string {
  const sdkMajorVersion = parseSdkMajorVersion(sdkVersion);

  if (sdkMajorVersion >= 33) {
    return indentString(
      `
# Install unimodules
require_relative '../node_modules/react-native-unimodules/cocoapods.rb'
use_unimodules!(
  modules_paths: ['${universalModulesPath}'],
  exclude: [
    'expo-bluetooth',
    'expo-in-app-purchases',
    'expo-payments-stripe',
  ],
)`,
      2
    );
  } else {
    return indentString(
      universalModules
        .map(moduleInfo =>
          _renderUnversionedUniversalModuleDependency(
            moduleInfo.podName,
            moduleInfo.path,
            sdkVersion
          )
        )
        .join('\n'),
      2
    );
  }
}

function _renderUnversionedUniversalModuleDependency(
  podName: string,
  path: string,
  sdkVersion?: string
): string {
  const attributes = {
    path,
  };
  return `pod '${podName}',
${indentString(_renderDependencyAttributes(attributes), 2)}`;
}

/**
 *  @param pathToTemplate path to template Podfile
 *  @param pathToOutput path to render final Podfile
 *  @param moreSubstitutions dictionary of additional substitution keys and values to replace
 *         in the template, such as: TARGET_NAME, REACT_NATIVE_PATH
 */
export async function renderPodfileAsync(
  pathToTemplate: string,
  pathToOutput: string,
  moreSubstitutions: undefined | { [key: string]: any },
  shellAppSdkVersion: any,
  sdkVersion = 'UNVERSIONED'
) {
  if (!moreSubstitutions) {
    moreSubstitutions = {};
  }
  let templatesDirectory = path.dirname(pathToTemplate);
  let templateString = await fs.readFile(pathToTemplate, 'utf8');

  let reactNativePath = moreSubstitutions.REACT_NATIVE_PATH;
  let rnDependencyOptions;
  if (reactNativePath) {
    rnDependencyOptions = { reactNativePath };
  } else {
    rnDependencyOptions = {};
  }

  const expoKitPath = moreSubstitutions.EXPOKIT_PATH;
  const expoKitTag = moreSubstitutions.EXPOKIT_TAG;
  let expoKitDependencyOptions = {};
  if (expoKitPath) {
    expoKitDependencyOptions = { expoKitPath };
  } else if (expoKitTag) {
    expoKitDependencyOptions = { expoKitTag };
  }

  let versionedRnPath = moreSubstitutions.VERSIONED_REACT_NATIVE_PATH;
  if (!versionedRnPath) {
    versionedRnPath = './versioned-react-native';
  }
  let rnExpoSubspecs = moreSubstitutions.REACT_NATIVE_EXPO_SUBSPECS;
  if (!rnExpoSubspecs) {
    rnExpoSubspecs = ['Expo'];
  }

  let versionedDependencies = await _renderVersionedReactNativeDependenciesAsync(
    templatesDirectory,
    versionedRnPath,
    rnExpoSubspecs,
    shellAppSdkVersion
  );
  let versionedPostinstalls = await _renderVersionedReactNativePostinstallsAsync(
    templatesDirectory,
    shellAppSdkVersion
  );
  let podDependencies = await _renderPodDependenciesAsync(
    path.join(templatesDirectory, 'dependencies.json'),
    { isPodfile: true }
  );

  let universalModules = moreSubstitutions.UNIVERSAL_MODULES;
  if (!universalModules) {
    universalModules = [];
  }

  let substitutions: { [key: string]: string } = {
    EXPONENT_CLIENT_DEPS: podDependencies,
    EXPOKIT_DEPENDENCY: _renderExpoKitDependency(expoKitDependencyOptions, sdkVersion),
    PODFILE_UNVERSIONED_EXPO_MODULES_DEPENDENCIES: _renderUnversionedUniversalModulesDependencies(
      universalModules,
      moreSubstitutions.UNIVERSAL_MODULES_PATH,
      sdkVersion
    ),
    PODFILE_UNVERSIONED_RN_DEPENDENCY: _renderUnversionedReactNativeDependency(
      rnDependencyOptions,
      sdkVersion
    ),
    PODFILE_UNVERSIONED_POSTINSTALL: _renderUnversionedPostinstall(sdkVersion),
    PODFILE_DETACHED_POSTINSTALL: _renderDetachedPostinstall(sdkVersion, false),
    PODFILE_DETACHED_SERVICE_POSTINSTALL: _renderDetachedPostinstall(sdkVersion, true),
    PODFILE_VERSIONED_RN_DEPENDENCIES: versionedDependencies,
    PODFILE_VERSIONED_POSTINSTALLS: versionedPostinstalls,
    PODFILE_TEST_TARGET: shellAppSdkVersion ? '' : _renderTestTarget(reactNativePath),
    ...moreSubstitutions,
  };
  _validatePodfileSubstitutions(substitutions);

  let result = templateString;
  for (let key in substitutions) {
    if (substitutions.hasOwnProperty(key)) {
      let replacement = substitutions[key];
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), replacement);
    }
  }

  await fs.writeFile(pathToOutput, result);
}