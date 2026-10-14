#!/usr/bin/env python3
"""Deterministic Xcode project without third-party project generators."""
from pathlib import Path
import hashlib, os, re
existing_project = Path(__file__).resolve().parents[1]/"Melo.xcodeproj/project.pbxproj"
existing_text = existing_project.read_text() if existing_project.exists() else ""
existing_bundle = re.search(r'PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([A-Za-z0-9.-]+)', existing_text)
existing_team = re.search(r'DEVELOPMENT_TEAM\s*=\s*"?([A-Za-z0-9]+)', existing_text)
bundle_id = os.environ.get("MELO_BUNDLE_ID", existing_bundle.group(1) if existing_bundle else "com.melo.iphone")
team_id = os.environ.get("MELO_APPLE_TEAM_ID", existing_team.group(1) if existing_team else "")
if team_id and not re.fullmatch(r"[A-Za-z0-9]+", team_id):
    raise SystemExit("Invalid MELO_APPLE_TEAM_ID")
if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle_id):
    raise SystemExit("Invalid MELO_BUNDLE_ID")
root = Path(__file__).resolve().parents[1]
def uid(s): return hashlib.sha1(s.encode()).hexdigest()[:24].upper()
objects = []
def obj(key, body): objects.append(f'{uid(key)} = {{ {body} }};'); return uid(key)
sources = sorted((root/'Melo').glob('*.swift'))
refs, builds = [], []
for source in sources:
    ref = obj(source.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {source.name}; sourceTree = "<group>";')
    refs.append(ref)
    builds.append(obj('build'+source.name, f'isa = PBXBuildFile; fileRef = {ref};'))
resourcebuilds = []
for resource in sorted((root/'Melo').glob('Icon-*.png')):
    ref = obj(resource.name, f'isa = PBXFileReference; lastKnownFileType = image.png; path = "{resource.name}"; sourceTree = "<group>";')
    refs.append(ref)
    resourcebuilds.append(obj('build'+resource.name, f'isa = PBXBuildFile; fileRef = {ref};'))
scene = obj('sceneFolder', 'isa = PBXFileReference; lastKnownFileType = folder; path = Scene; sourceTree = "<group>";')
refs.append(scene)
resourcebuilds.append(obj('buildScene', f'isa = PBXBuildFile; fileRef = {scene};'))
app = obj('app', 'isa = PBXFileReference; explicitFileType = wrapper.application; path = Melo.app; sourceTree = BUILT_PRODUCTS_DIR;')
srcgroup = obj('srcgroup', f'isa = PBXGroup; path = Melo; sourceTree = "<group>"; children = ({",".join(refs)},);')
products = obj('products', f'isa = PBXGroup; name = Products; sourceTree = "<group>"; children = ({app},);')
main = obj('main', f'isa = PBXGroup; sourceTree = "<group>"; children = ({srcgroup},{products},);')
srcphase = obj('sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(builds)},); runOnlyForDeploymentPostprocessing = 0;')
frameworks = obj('frameworks', 'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
resources = obj('resources', f'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(resourcebuilds)},); runOnlyForDeploymentPostprocessing = 0;')
projectconfigs, targetconfigs = [], []
for configuration in ['Debug','Release']:
    projectconfigs.append(obj('proj'+configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ CLANG_ENABLE_MODULES = YES; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; }};'))
    settings = '''PRODUCT_BUNDLE_IDENTIFIER = com.melo.iphone; PRODUCT_NAME = Melo; TARGETED_DEVICE_FAMILY = 1; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_FILE = Melo/Info.plist; INFOPLIST_KEY_CFBundleDisplayName = Melo; INFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.productivity"; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait; MARKETING_VERSION = 0.5.16; CURRENT_PROJECT_VERSION = 21; SWIFT_EMIT_LOC_STRINGS = YES; ENABLE_USER_SCRIPT_SANDBOXING = YES; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";'''
    settings = settings.replace('com.melo.iphone', bundle_id)
    if team_id: settings += f' DEVELOPMENT_TEAM = {team_id};'
    settings += ' SWIFT_OPTIMIZATION_LEVEL = "-Onone"; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; DEBUG_INFORMATION_FORMAT = dwarf;' if configuration == 'Debug' else ' SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
    targetconfigs.append(obj('target'+configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ {settings} }};'))
def configs(key, values): return obj(key, f'isa = XCConfigurationList; buildConfigurations = ({",".join(values)},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
pc = configs('pc',projectconfigs); tc = configs('tc',targetconfigs)
target = obj('target',f'isa = PBXNativeTarget; buildConfigurationList = {tc}; buildPhases = ({srcphase},{frameworks},{resources},); buildRules = (); dependencies = (); name = Melo; productName = Melo; productReference = {app}; productType = "com.apple.product-type.application";')
project = obj('project', f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 2600; }}; buildConfigurationList = {pc}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base,"zh-Hans"); mainGroup = {main}; productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = ({target},);')
(root/'Melo.xcodeproj/project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'+'\n'.join(objects)+f'\n}}; rootObject = {project}; }}\n')
