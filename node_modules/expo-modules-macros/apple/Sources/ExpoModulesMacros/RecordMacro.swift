import SwiftDiagnostics
import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

/**
 Member macro applied to a record type. Treats **every stored property** that is not
 `static`, `private`, `fileprivate`, `lazy` or computed as a property — no `@Field` wrapper
 needed — and synthesizes the conversion surface from the property's static type:

 - an explicit memberwise `init` (so the static factories have a single construction point),
 - `from(object:appContext:)` — the fast path, reading each property straight off a
   `JavaScriptObject`,
 - `from(dictionary:appContext:)` — reading each property from a `[String: Any]` dictionary,
 - `toDictionary(appContext:)` and `toObject(appContext:)` for the write side.

 The type is auto-conformed to `Record` (a core protocol whose requirements are exactly this
 surface); the synthesized methods override `Record`'s reflection-based defaults. Author-facing
 shape — no conformance to spell out:

   @Record
   struct Options {
     var name: String          // required (non-optional, no default)
     var count: Int = 0        // optional (has default)
     var note: String?         // nullable + optional
   }

 The JS key is always the property name. Requiredness is inferred from the declaration:
 a default value makes a property optional (the default applies when the source omits it),
 an optional type makes it nullable and optional, and a non-optional property without a
 default is required (the factories throw when the source omits it).

 The JS-value paths convert through `JavaScriptDecodable.decode` / `JavaScriptEncodable.encode`
 (`from(object:)` / `toObject(appContext:)`); the native-`Any` dictionary paths still go through the
 public dynamic-type API — `T.getDynamicType()` plus `cast(_:appContext:)` / `convertToJS(_:appContext:)`
 (`from(dictionary:)` / `toDictionary(appContext:)`), since `JavaScriptCodable` only converts JS
 values, not native `Any`. Both spell types as `public` symbols so the synthesized code compiles inside
 user modules without any internal core symbols. Every property type must therefore conform to both
 `AnyArgument` and `JavaScriptDecodable & JavaScriptEncodable`.

 A property whose type mentions `Any` (`Any?`, `[String: Any]?`, `[String: [Any]]`, …) can't conform to
 the JS codable protocols. On the JS-value paths it converts through the `JavaScriptValue` free-form
 methods instead: `decodeAny`/`decodeAnyArray`/`decodeAnyDictionary` and the matching `encodeAny…`
 for `Any`, `[Any]` and `[String: Any]` (optional or not), and the generic `decodeAny(_:as:in:)` /
 `encodeAny(_:in:)` for any other type. Such a property only needs `AnyArgument` for the dictionary
 paths, and a bare `Any` needs nothing, since the dictionary paths pass it through unchanged.

 For classes that inherit from another `@Record`-annotated class, the synthesized
 methods chain to `super` so inherited properties are handled first.
 */
public struct RecordMacro: MemberMacro, ExtensionMacro {
  public static func expansion(
    of node: AttributeSyntax,
    providingMembersOf declaration: some DeclGroupSyntax,
    conformingTo protocols: [TypeSyntax],
    in context: some MacroExpansionContext
  ) throws -> [DeclSyntax] {
    let isClass = declaration.is(ClassDeclSyntax.self)
    guard declaration.is(StructDeclSyntax.self) || isClass else {
      throw MacroExpansionErrorMessage("@Record can only be applied to a struct or class")
    }

    let properties = try recordProperties(of: declaration)
    let inheritsRecord = isClass && classHasInheritance(declaration)

    // The user may hand-write any of the initializers the macro would otherwise synthesize. Emitting
    // a duplicate is a hard "invalid redeclaration" error, so skip anything already declared and let
    // the author's version stand — the factories only need *an* `init(<properties>)` and `Record` only
    // needs *an* `init()`, regardless of who wrote them.
    let existingInitLabels = initializerParameterLabels(of: declaration)

    var members: [DeclSyntax] = []

    // A single never-called member that makes the compiler verify each property type is convertible
    // both ways (the JS-value paths call `decode`/`encode`; the native-`Any` dictionary paths call
    // the dynamic-type API). Each property keeps its own named assertion inside, so the compiler's
    // conformance diagnostic names the offending property (see `typeConformanceAssertions`). Emitted
    // first so that, for a non-conforming type, this clear "requires that '…' conform to '…'" error
    // is reported ahead of the noisier "no member 'decode'"/"getDynamicType" errors from the
    // conversion code below.
    let assertions = properties.map { property in
      // A bare `Any` can't conform to anything and needs no conformance, since every path converts it
      // without one.
      ConformanceAssertion(
        name: property.name,
        types: property.freeForm?.isBareAny == true ? [] : [property.type],
        constraint: property.freeForm != nil ? jsConvertibleProtocolName : nil
      )
    }
    if let assertionMember = typeConformanceAssertions(for: assertions, constraint: recordFieldProtocolName) {
      members.append(assertionMember)
    }

    if !existingInitLabels.contains([]) {
      if let defaultInit = defaultInit(properties: properties, isClass: isClass) {
        members.append(defaultInit)
      }
    }
    if !existingInitLabels.contains(properties.map { $0.key }) {
      members.append(memberwiseInit(properties: properties))
    }
    members.append(fromJSObjectFactory(properties: properties))
    members.append(fromDictionaryFactory(properties: properties))
    members.append(toDictionaryMethod(properties: properties, inheritsRecord: inheritsRecord))
    members.append(toObjectMethod(properties: properties, inheritsRecord: inheritsRecord))
    return members
  }

  /**
   Auto-conforms the type to `Record` — the protocol whose requirements are exactly the members
   synthesized above (`init()`, the two `from(_:)` factories, and the `toDictionary`/`toObject`
   write side), which the synthesized methods satisfy by overriding `Record`'s reflection-based
   defaults.

   The conformance is skipped when the type already declares it, and for class subclasses
   (which inherit it from a `@Record`-annotated parent) no extension is emitted at all.
   */
  public static func expansion(
    of node: AttributeSyntax,
    attachedTo declaration: some DeclGroupSyntax,
    providingExtensionsOf type: some TypeSyntaxProtocol,
    conformingTo protocols: [TypeSyntax],
    in context: some MacroExpansionContext
  ) throws -> [ExtensionDeclSyntax] {
    if declaration.is(ClassDeclSyntax.self) && classHasInheritance(declaration) {
      return []
    }
    guard declaration.is(StructDeclSyntax.self) || declaration.is(ClassDeclSyntax.self) else {
      return []
    }
    if inheritsProtocol(named: "Record", in: declaration) {
      return []
    }

    let ext: DeclSyntax = """
      extension \(type.trimmed): Record {}
      """
    guard let extDecl = ext.as(ExtensionDeclSyntax.self) else {
      return []
    }
    return [extDecl]
  }
}

// MARK: - Property model

/**
 A single record property discovered on the type, paired with everything the synthesized
 conversions need: its property name, its written type, and how the source may omit it.
 */
private struct RecordProperty {
  /// The property name as written, backticks included for an escaped name (`` `default` ``), since
  /// every identifier position in the generated code needs them.
  let name: String
  /// The property's declared type, verbatim (e.g. `String`, `Int`, `String?`). Used to build the
  /// memberwise-init parameter and as the receiver of the per-property `decode`/`encode` (and, on the
  /// dictionary paths, `getDynamicType()`) conversions.
  let type: String
  /// The default-value expression verbatim (`0`, `""`, `[]`), or `nil` when the property has none.
  /// Inlined into the memberwise init and the factories' omitted-property branch so the synthesized
  /// code never needs a throwaway `Self()` to recover defaults.
  let defaultValue: String?
  /// True when the property's type is optional (`T?` / `T!` / `Optional<T>`).
  let isOptional: Bool
  /// How the property converts when its type mentions `Any`, or `nil` for every other type.
  let freeForm: FreeFormConversion?

  /// True when the property declares a default value (`var x: T = …`).
  var hasDefault: Bool {
    return defaultValue != nil
  }

  /// Required properties must be present in the source; omission throws.
  var isRequired: Bool {
    return !hasDefault && !isOptional
  }

  /// The key the property reads from and writes to, in both the JS object and the dictionary: the
  /// name without escaping backticks.
  var key: String {
    return withoutBackticks(name)
  }
}

/**
 Discovers the record's properties: every stored `var`/`let` binding that is not `static`,
 `private`, `fileprivate`, `lazy`, or computed. Each property must declare an explicit type
 annotation, since the synthesized conversions name the type (e.g. `Type.decode(…)`).
 */
private func recordProperties(
  of declaration: some DeclGroupSyntax
) throws -> [RecordProperty] {
  var properties: [RecordProperty] = []

  for member in declaration.memberBlock.members {
    guard let varDecl = member.decl.as(VariableDeclSyntax.self) else {
      continue
    }
    if isExcludedByModifier(varDecl.modifiers) {
      continue
    }
    // `@Field` is the v1 property wrapper and has no meaning here — every stored property is a
    // record property now. Left in place it would wrap the value in `Field<T>` (backing storage
    // `_name`), so the synthesized conversions would be generated against the wrong type. Flag it
    // explicitly rather than emit broken code.
    if varDecl.attributes.firstAttribute(named: "Field") != nil {
      throw MacroExpansionErrorMessage(
        "@Field is no longer used — @Record treats every stored property as a record property. Remove the @Field attribute"
      )
    }
    for binding in varDecl.bindings {
      // Computed properties (and `{ get set }`) carry an accessor block — never properties.
      if binding.accessorBlock != nil {
        continue
      }
      guard let ident = binding.pattern.as(IdentifierPatternSyntax.self) else {
        continue
      }
      // Prefer the explicit annotation. When it's omitted, recover the type from a literal default
      // (Swift's own default-literal type) — covers the common `var name = "foo"` case. Anything
      // whose type a syntactic macro can't determine (calls, collections, member access) still needs
      // an annotation.
      let inferredType = binding.typeAnnotation?.type.trimmedDescription
        ?? binding.initializer.flatMap { inferredLiteralType(of: $0.value) }
      guard let type = inferredType else {
        throw MacroExpansionErrorMessage(
          "@Record properties must declare an explicit type — '\(ident.identifier.text)' has none"
        )
      }
      // A literal-inferred type never mentions `Any` or a closure, so only an explicit annotation can.
      let annotatedType = binding.typeAnnotation?.type
      // A closure has no `decode`, `encode` or dynamic type, and the record converts every property both
      // ways. A JavaScript function decodes into a native closure only as a `@JS` argument; a native
      // closure can't be encoded.
      if let functionType = annotatedType.flatMap(firstFunctionType(in:)) {
        throw DiagnosticsError(diagnostics: [
          Diagnostic(
            node: functionType,
            message: RecordDiagnosticMessage(
              "@Record property '\(ident.identifier.text)' can't hold a closure: a record property is also encoded to JavaScript, and a native closure can't be encoded",
              id: "record-closure-property"
            ))
        ])
      }
      let freeForm = try annotatedType.flatMap { annotatedType -> FreeFormConversion? in
        guard mentionsFreeFormAny(annotatedType) else {
          return nil
        }
        guard isConvertibleFreeFormType(annotatedType) else {
          throw MacroExpansionErrorMessage(
            "@Record property '\(ident.identifier.text)' can't be typed '\(type)', because a type holding Any converts to and from JavaScript only when it's built from Any, arrays, String-keyed dictionaries and optionals. Use one of those shapes, such as [String: Any], or JavaScriptValue to keep the JavaScript value unconverted"
          )
        }
        return FreeFormConversion(type: annotatedType)
      }
      properties.append(
        RecordProperty(
          name: ident.identifier.text,
          type: type,
          defaultValue: binding.initializer?.value.trimmedDescription,
          isOptional: annotatedType.map(isOptionalType) ?? false,
          freeForm: freeForm
        )
      )
    }
  }
  return properties
}

// MARK: - Synthesized members

/**
 The parameterless `init()` required by the `Record` protocol. Nothing in the synthesized code uses
 it — the factories construct through the memberwise init with defaults inlined — so it's purely a
 conformance witness. Swift only synthesizes an implicit `init()` for a struct that declares no other
 initializer, but the macro always emits a memberwise `init(…)`, which suppresses it, so for structs
 the macro must supply `init()` itself.

 When no property is required, the body is empty: every stored property initializes from its own
 declaration. When a property *is* required there's no value to give it, so the body traps — this `init()`
 is never reached (the `from(…)` factories don't call it), it exists only to satisfy the requirement.

 Not emitted when there are no properties at all — there the memberwise init already *is* `init()`. Classes
 are left alone: they inherit `init()` from their `@Record` superclass, and a base `@Record` class is
 unsupported today.
 */
private func defaultInit(properties: [RecordProperty], isClass: Bool) -> DeclSyntax? {
  if isClass || properties.isEmpty {
    return nil
  }
  if properties.contains(where: { $0.isRequired }) {
    return """
      public init() {
      fatalError("\\(Self.self) has required properties and cannot be created with init(); construct it through the @Record-synthesized from(dictionary:) or from(object:) factories")
      }
      """
  }
  return """
    public init() {
    }
    """
}

/**
 Explicit memberwise initializer over the discovered properties, in declaration order. The factories
 call this as the single construction point. Optional properties default to `nil` for ergonomics; all
 other parameters are required at this level (the factories supply a value for every property, inlining
 each declared default where the source omits it).
 */

private func memberwiseInit(properties: [RecordProperty]) -> DeclSyntax {
  let params = properties.map { property -> String in
    if property.isOptional {
      return "\(property.name): \(property.type) = nil"
    }
    return "\(property.name): \(property.type)"
  }
  let assignments = properties.map { "  self.\($0.name) = \($0.name)" }.joined(separator: "\n")
  let signature = params.joined(separator: ", ")

  return """
    public init(\(raw: signature)) {
    \(raw: assignments)
    }
    """
}

/**
 `from(object:appContext:)` — reads each property off the `JavaScriptObject` into a local,
 then constructs the record through the memberwise init. Required properties throw when
 undefined; defaulted properties fall back to the property's declared default (inlined) when
 undefined; optional properties become `nil` when undefined/null. Each property is decoded with
 `JavaScriptDecodable.decode`, so the factory binds the `runtime` from the app context once and
 threads it to every read. A free-form property decodes through the `JavaScriptValue` free-form
 methods, which take the runtime too.
 */
private func fromJSObjectFactory(properties: [RecordProperty]) -> DeclSyntax {
  var lines: [String] = []
  // Only bind the runtime when there's a property to decode — an empty record's factory would
  // otherwise leave it unused.
  if !properties.isEmpty {
    lines.append("  let runtime = try appContext.runtime")
  }
  lines.append(factoryBody(properties: properties, readLines: jsObjectReadLines(properties: properties)))
  let body = lines.joined(separator: "\n")
  return """
    @JavaScriptActor
    public static func from(object: borrowing JavaScriptObject, appContext: AppContext) throws -> Self {
    \(raw: body)
    }
    """
}

/**
 `from(dictionary:appContext:)` — same as the JS path but reads from `[String: Any]` and
 uses the `Any?` cast overload; a missing key is `dictionary[key] == nil`.
 */
private func fromDictionaryFactory(properties: [RecordProperty]) -> DeclSyntax {
  let body = factoryBody(properties: properties, readLines: dictionaryReadLines(properties: properties))
  return """
    public static func from(dictionary: [String: Any], appContext: AppContext) throws -> Self {
    \(raw: body)
    }
    """
}

/**
 Builds a factory body: per-property reads into locals, then a single call to the synthesized
 memberwise init. Each property's declared default expression is captured at parse time and inlined
 directly into the omitted-property branch (see the read-line builders), so the factory needs neither
 a throwaway `Self()` nor the record's `init()`.
 */
private func factoryBody(properties: [RecordProperty], readLines: [String]) -> String {
  var lines: [String] = []
  lines.append(contentsOf: readLines)
  let initArgs = properties.map { "\($0.name): \($0.name)" }.joined(separator: ", ")
  lines.append("  return Self(\(initArgs))")
  return lines.joined(separator: "\n")
}

/// Per-property read statements for the JS-object factory, each producing a `let <name>` by decoding
/// the JS value with `JavaScriptDecodable.decode` (recovering the app context from `runtime` itself).
/// A free-form property decodes through the `JavaScriptValue` free-form methods instead; for an optional
/// free-form shape, `undefined`/`null` map to `nil` around the call, just like `Optional.decode`.
private func jsObjectReadLines(properties: [RecordProperty]) -> [String] {
  var lines: [String] = []
  for property in properties {
    let valueVar = derivedIdentifier(from: property.name, suffix: "JSValue")
    let exprType = expressionType(property.type)
    let decode: String
    switch property.freeForm {
    case .shape(let decodeMethod, _, let isOptional, _):
      let call = "try JavaScriptValue.\(decodeMethod)(\(valueVar), in: runtime)"
      decode = isOptional ? "\(valueVar).isUndefined() || \(valueVar).isNull() ? nil : \(call)" : call
    case .generic:
      decode = "try JavaScriptValue.decodeAny(\(valueVar), as: \(exprType).self, in: runtime)"
    case nil:
      decode = "try \(exprType).decode(\(valueVar), in: runtime)"
    }
    lines.append("  let \(valueVar) = object.getProperty(\"\(property.key)\")")
    if property.isRequired {
      lines.append("  guard !\(valueVar).isUndefined() else {")
      lines.append("    throw RecordPropertyRequiredException(\"\(property.key)\")")
      lines.append("  }")
      lines.append("  let \(property.name) = \(decode)")
    } else if property.isOptional {
      // `Optional.decode` (and the free-form reads above) already map `undefined`/`null` to `nil`, so
      // the read is a plain decode.
      lines.append("  let \(property.name) = \(decode)")
    } else {
      lines.append("  let \(property.name) = \(valueVar).isUndefined() ? \(property.defaultValue!) : \(decode)")
    }
  }
  return lines
}

/// Per-property read statements for the dictionary factory, each producing a `let <name>`. A bare `Any`
/// property has no dynamic type to cast through, and the dictionary value already is an `Any`, so it's
/// read unchanged.
private func dictionaryReadLines(properties: [RecordProperty]) -> [String] {
  var lines: [String] = []
  for property in properties {
    let valueVar = derivedIdentifier(from: property.name, suffix: "Value")
    let exprType = expressionType(property.type)
    let isBareAny = property.freeForm?.isBareAny == true
    let cast = isBareAny
      ? valueVar
      : "try \(exprType).getDynamicType().cast(\(valueVar), appContext: appContext) as! \(exprType)"
    lines.append("  let \(valueVar) = dictionary[\"\(property.key)\"]")
    if property.isRequired {
      lines.append("  guard let \(valueVar) else {")
      lines.append("    throw RecordPropertyRequiredException(\"\(property.key)\")")
      lines.append("  }")
      lines.append("  let \(property.name) = \(cast)")
    } else if property.isOptional {
      lines.append("  let \(property.name): \(property.type) = (\(valueVar) == nil || \(valueVar)! is NSNull) ? nil : \(cast)")
    } else {
      lines.append("  let \(property.name) = \(valueVar) == nil ? \(property.defaultValue!) : \(isBareAny ? valueVar + "!" : cast)")
    }
  }
  return lines
}

/**
 `toDictionary(appContext:)` — converts each property back to a JS-compatible value via the
 dynamic type and assembles a `[String: Any]`. Inherited properties are merged in first.
 */
private func toDictionaryMethod(properties: [RecordProperty], inheritsRecord: Bool) -> DeclSyntax {
  let overrideKeyword = inheritsRecord ? "override " : ""
  var lines: [String] = []
  if inheritsRecord {
    lines.append("  var dictionary = super.toDictionary(appContext: appContext)")
  } else {
    lines.append("  var dictionary: [String: Any] = [:]")
  }
  for property in properties {
    lines.append("  dictionary[\"\(property.key)\"] = self.\(property.name)")
  }
  lines.append("  return dictionary")
  let body = lines.joined(separator: "\n")

  if inheritsRecord {
    return """
      public \(raw: overrideKeyword)func toDictionary(appContext: AppContext? = nil) -> [String: Any] {
      \(raw: body)
      }
      """
  }
  return """
    public func toDictionary(appContext: AppContext? = nil) -> [String: Any] {
    \(raw: body)
    }
    """
}

/**
 `toObject(appContext:)` — builds a `JavaScriptObject` directly, encoding each property with
 `JavaScriptEncodable.encode` (or, for a free-form property, the matching `JavaScriptValue` free-form
 method). The fast write path mirroring `from(object:)`. The `runtime` is bound
 from the app context once and threaded to every write. Subclasses chain to `super` so inherited
 properties are written first.
 */
private func toObjectMethod(properties: [RecordProperty], inheritsRecord: Bool) -> DeclSyntax {
  let overrideKeyword = inheritsRecord ? "override " : ""
  var lines: [String] = []
  // The base case needs the runtime to create the object; the inheriting case only needs it when
  // there's a property to encode (it chains to `super` for the object itself). Binding it when unused
  // would warn.
  if !inheritsRecord || !properties.isEmpty {
    lines.append("  let runtime = try appContext.runtime")
  }
  if inheritsRecord {
    lines.append("  let object = try super.toObject(appContext: appContext)")
  } else {
    lines.append("  let object = runtime.createObject()")
  }
  for property in properties {
    let exprType = expressionType(property.type)
    let encode: String
    switch property.freeForm {
    case .shape(_, let encodeMethod, let isOptional, _):
      encode = isOptional
        ? "self.\(property.name) == nil ? .null() : try JavaScriptValue.\(encodeMethod)(self.\(property.name)!, in: runtime)"
        : "try JavaScriptValue.\(encodeMethod)(self.\(property.name), in: runtime)"
    case .generic:
      // The explicit `as Any` keeps an optional property from warning about its implicit coercion.
      encode = "try JavaScriptValue.encodeAny(self.\(property.name) as Any, in: runtime)"
    case nil:
      encode = "try \(exprType).encode(self.\(property.name), in: runtime)"
    }
    lines.append("  object.setProperty(\"\(property.key)\", value: \(encode))")
  }
  lines.append("  return object")
  let body = lines.joined(separator: "\n")

  return """
    @JavaScriptActor
    public \(raw: overrideKeyword)func toObject(appContext: AppContext) throws -> JavaScriptObject {
    \(raw: body)
    }
    """
}

// MARK: - Helpers

/**
 The parameter-label list of every initializer the type already declares, used to avoid emitting a
 duplicate of one the author hand-wrote. Each entry is the ordered external argument labels of one
 `init` — e.g. `init(name: String, count: Int)` → `["name", "count"]`, and `init()` → `[]`. A
 parameter written with `_` or with no external label contributes its internal name's absence as an
 empty-string label, which simply won't match the macro's always-labeled signatures (a safe miss).
 */
private func initializerParameterLabels(of declaration: some DeclGroupSyntax) -> [[String]] {
  var signatures: [[String]] = []
  for member in declaration.memberBlock.members {
    guard let initDecl = member.decl.as(InitializerDeclSyntax.self) else {
      continue
    }
    let labels = initDecl.signature.parameterClause.parameters.map { parameter in
      // `firstName` is the external label (or `_`); fall back to the internal name when omitted.
      let label = withoutBackticks(parameter.firstName.text)
      return label == "_" ? "" : label
    }
    signatures.append(labels)
  }
  return signatures
}

/**
 True if the class declaration has any inheritance clause. Used as a heuristic for
 whether the superclass also conforms to `Record` and provides the synthesized methods;
 the macro emits `override` in this case.
 */
private func classHasInheritance(_ declaration: some DeclGroupSyntax) -> Bool {
  guard let classDecl = declaration.as(ClassDeclSyntax.self),
    let inherited = classDecl.inheritanceClause?.inheritedTypes,
    !inherited.isEmpty else {
    return false
  }
  return true
}

private struct RecordDiagnosticMessage: DiagnosticMessage {
  let message: String
  let diagnosticID: MessageID
  let severity: DiagnosticSeverity = .error

  init(_ message: String, id: String) {
    self.message = message
    self.diagnosticID = MessageID(domain: "ExpoModulesMacros", id: id)
  }
}
