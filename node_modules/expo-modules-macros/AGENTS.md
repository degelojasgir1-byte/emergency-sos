# AGENTS.md

`expo-modules-macros` is the Swift compiler plugin that implements the macros declared by `expo-modules-core`, plus a source scanner CLI built into the same executable. Read `README.md` first for what each macro does and how the plugin reaches the compiler.

## Layout

- `apple/Package.swift`: the SwiftPM package. The test targets are declared only when `apple/Tests` exists, because the published npm package leaves it out.
- `apple/Sources/ExpoModulesMacros`: the macro implementations. `Plugin.swift` registers every macro in `providingMacros` and holds the entry point that sends any invocation with arguments to the scanner CLI.
- `apple/Sources/ExpoModulesScanner`: the scanner library. `Modules/` implements `scan-modules` (autolinking), `Exports/` implements `scan-exports` (type generation), `Core/` holds the shared parsing and `#if` evaluation, and `CLI.swift` is the command-line front end.
- `apple/Sources/ExpoModulesOptimized`: declarations for the `@OptimizedFunction` macro.
- `apple/Tests`: `ExpoModulesMacrosTests` (expansion tests) and `ExpoModulesScannerTests`.
- `platforms/`: the Windows packages `@expo/modules-macros-win32-x64` and `-arm64` (a `package.json` with `os` and `cpu`, a README and a copy of `LICENSE`). The Publish workflow runs `scripts/set-platform-versions.js` to give them the version of this package. Their `ExpoModulesMacros.exe` is written there by `npm run build` on Windows and isn't committed.
- `apple/PodTests`: a stub test so that `expo/expo` native tests can install this package as a pod. Do not add real tests here.
- `src/`: the TypeScript wrapper around the scanner CLI. `types.ts` mirrors the Swift `Codable` output types by hand.
- `scripts/build.js` (`npm run build`): builds the release binaries: the universal macOS `apple/ExpoModulesMacros` (committed and published), and on Windows `platforms/win32-<arch>/ExpoModulesMacros.exe` for the host architecture (not committed; published in that package).

## Commands

Swift 6.2 is required (Xcode 26 or newer on macOS).

```sh
cd apple && swift build      # debug build
cd apple && swift test       # all Swift tests
npm run typecheck            # TypeScript wrapper
npm run build                # release binary (slow; on macOS uses Rosetta for x86_64)
```

CI runs on macOS (`.github/workflows/swift.yml`) and on Windows x64 and arm64 (`.github/workflows/windows.yml`). On macOS it runs the release build, checks both binary slices, then runs `swift test` and `npm run typecheck`. On Windows it builds and tests the package, builds the release binary, checks that it starts without the Swift runtime, packs it into its `platforms/` package (checking the files and the `os`/`cpu` fields), installs that package, and scans through the TypeScript wrapper, which must find the executable there. Code in `Sources` and `Tests` must not assume Apple platforms or POSIX paths.

## Windows

- Outside Apple platforms, `Sources` import `FoundationEssentials` instead of `Foundation` (`#if canImport(FoundationEssentials)`). Full Foundation brings in ICU, which would add tens of megabytes to the statically linked Windows binary. Don't use APIs that only `Foundation` has (`FileHandle`, `NSRegularExpression`, `CharacterSet`, `FileManager.enumerator`, `NSString` path methods); `Core/StandardStreams.swift` writes to stdout and stderr.
- The Windows binaries link the Swift runtime statically (`-static-stdlib`), because Swift has no stable ABI on Windows and the scanner must also run without a Swift toolchain. SwiftPM's `--static-swift-stdlib` has no effect there.

## Conventions

- Swift uses 2-space indentation. Write new doc comments as `///` line comments, not `/** */` blocks.
- Tests use Swift Testing (`import Testing`, `@Test`) with backtick-quoted descriptive names, for example ``func `Prunes .build, Pods, .git, and node_modules directories`()``.
- Macro tests compare full expansions with `assertMacroExpansion` from `SwiftSyntaxMacrosGenericTestSupport`, using `indentationWidth: .spaces(2)`. Each test file wraps it in a local `assertExpansion` helper.
- Scanner tests reach internal API with `@testable import ExpoModulesScanner`. Do not make scanner types `public` only for tests.
- `@JS` applies to functions, properties and initializers. Do not write code or comments that assume it marks only functions.
- Code comments describe the code as it is. Do not refer to open PRs, branches or planned work.

## Changing macros

- The scanner re-implements the macros' naming and member rules on the syntax tree; it does not call the macro code. When a macro changes which members it binds or how it names them (the `@JS` name override, the `on` prefix `@Event` strips, which properties `@Record` treats as fields), change `scan-exports` to match, or generated TypeScript types drift from the runtime.
- The scanner only parses files that match the pre-filter built by `macroAttributeRegex` in `Core/SourceScan.swift`. A new attribute or conformance the scanner must detect has to be added there, or files that use it are skipped without an error.
- A new macro needs: the implementation in `apple/Sources/ExpoModulesMacros`, an entry in `providingMacros` in `Plugin.swift`, an expansion test file, the `#externalMacro` declaration in `expo-modules-core`, and an entry in the macro list in `README.md`.

## Contracts with other packages

- **Macro declarations live in `expo-modules-core`** (`ios/Core/ExpoModulesMacros.swift` in `expo/expo`), as `#externalMacro(module: "ExpoModulesMacros", type: ...)`. Adding a macro, renaming a macro type or changing a macro's signature needs a matching edit there, and the type must be listed in `providingMacros` in `Plugin.swift`.
- **Generated code calls `expo-modules-core` API.** An expansion that uses a new core symbol only works with a core version that has it.
- **Scanner output is versioned.** `scanModulesSchemaVersion` (`Modules/ScanModules.swift`) and `scanExportsSchemaVersion` (`Exports/ExportedSurface.swift`) change independently. When the output shape of a command changes, bump its version and update the matching `SUPPORTED_SCAN_*_SCHEMA_VERSION` constant and mirror types in `src/types.ts`. `expo-modules-autolinking` also checks the `scan-modules` version.
- **The binary path is part of the contract.** `expo-modules-autolinking` resolves this package from `expo-modules-core` and passes `-load-plugin-executable <package>/apple/<binary>#ExpoModulesMacros` to the compiler. The scanner wrapper in autolinking uses the same path, and `expo-modules-cli` uses `getScannerBinaryPath()`. On Windows the binary is `ExpoModulesMacros.exe` in `@expo/modules-macros-win32-<arch>`. Renaming or moving a binary needs a matching change in `expo/expo`.

## Releases

- Do not rebuild or commit the binary under `apple/` in a feature change. Only the **Publish** workflow (`.github/workflows/publish.yml`, manual) rebuilds it, and it commits the result as `Release vX.Y.Z` after the npm publish succeeds. It also builds the Windows binaries and publishes them in the `platforms/` packages, with the same version.
- Do not edit the `version` in `package.json` by hand. The Publish workflow bumps it.
- Commit and PR titles are short and imperative, with code identifiers in backticks, for example ``Report `@Union` types in `scan-exports` ``.

## Installed copies

In `node_modules`, the compiler runs the prebuilt binary `apple/ExpoModulesMacros` (on Windows, `ExpoModulesMacros.exe` from `@expo/modules-macros-win32-<arch>`); editing the Swift sources there has no effect. Macro and scanner fixes belong in this repository and ship in a new release. The TypeScript wrapper ships compiled in `build/`, since `src/` is not published.
