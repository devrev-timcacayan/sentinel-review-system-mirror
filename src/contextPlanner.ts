import ts from 'typescript';
import type { Change, ContextPlan, DependencyEdge } from './contracts.ts';

export interface ContextRevision {
  sources: ReadonlyMap<string, string>;
  edges: readonly DependencyEdge[];
  resolveImport: (importer: string, specifier: string) => string | null;
}

export interface ContextPlannerInput {
  revisions: readonly ContextRevision[];
  changes: readonly Change[];
  additionalContextPaths: readonly string[];
}

export interface ContextPlannerResult {
  selectedPaths: string[];
  dependencyEdges: DependencyEdge[];
  evidence: ContextPlan;
}

type BindingKind = 'named' | 'default' | 'namespace' | 'sideeffect' | 'require' | 'dynamic' | 'import-equals' | 'opaque-edge';

interface Binding {
  local: string | null;
  kind: BindingKind;
  module: string;
  imported: string;
}

interface ExternalRef {
  module: string;
  imported: string;
}

interface ReExport {
  name: string;
  module: string;
  imported: string;
}

interface Decl {
  name: string;
  refs: Set<string>;
  exportNames: string[];
  declarative: boolean;
}

interface ModuleInfo {
  path: string;
  bindings: Binding[];
  externals: Map<string, ExternalRef>;
  externalExports: Set<string>;
  reExports: ReExport[];
  starExports: string[];
  listExports: Map<string, string>;
  decls: Map<string, Decl>;
  effects: boolean;
  exportsOpaque: boolean;
  modelIssues: string[];
}

const DEFAULT_DECL_NAME = '<default>';

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier: ts.Modifier): boolean => modifier.kind === kind);
}

function bindingIdentifiers(name: ts.BindingName, out: Set<string>): Set<string> {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return out;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingIdentifiers(element.name, out);
  }
  return out;
}

function collectPatternRefs(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) return;
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      collectRefs(element.propertyName, out);
    }
    collectPatternRefs(element.name, out);
    if (element.initializer) collectRefs(element.initializer, out);
  }
}

function collectRefs(node: ts.Node, out: Set<string>): void {
  if (ts.isComputedPropertyName(node)) {
    collectRefs(node.expression, out);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    collectRefs(node.expression, out);
    return;
  }
  if (ts.isQualifiedName(node)) {
    collectRefs(node.left, out);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) collectRefs(node.name, out);
    collectRefs(node.initializer, out);
    return;
  }
  if (ts.isBindingElement(node)) {
    if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) collectRefs(node.propertyName, out);
    collectPatternRefs(node.name, out);
    if (node.initializer) collectRefs(node.initializer, out);
    return;
  }
  if (ts.isParameter(node)) {
    collectPatternRefs(node.name, out);
    if (node.initializer) collectRefs(node.initializer, out);
    if (node.type) collectRefs(node.type, out);
    return;
  }
  if (ts.isVariableDeclaration(node)) {
    collectPatternRefs(node.name, out);
    if (node.type) collectRefs(node.type, out);
    if (node.initializer) collectRefs(node.initializer, out);
    return;
  }
  if (ts.isIdentifier(node)) {
    out.add(node.text);
    return;
  }
  ts.forEachChild(node, (child: ts.Node): void => {
    collectRefs(child, out);
  });
}

function isClassLike(node: ts.Node): node is ts.ClassDeclaration | ts.ClassExpression {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || isClassLike(node);
}

function isStatic(member: ts.ClassElement): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier: ts.Modifier): boolean => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

interface EffectContext {
  externals: Map<string, ExternalRef>;
  decls: Map<string, Decl>;
}

function isRecognizedCallee(expression: ts.Expression, ctx: EffectContext): boolean {
  if (ts.isIdentifier(expression)) {
    const external = ctx.externals.get(expression.text);
    return external?.module === '@playwright/test' && (external.imported === 'mergeTests' || external.imported === 'mergeExpects');
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'extend') {
    const target = expression.expression;
    if (!ts.isIdentifier(target)) return false;
    const external = ctx.externals.get(target.text);
    if (external?.module === '@playwright/test' && external.imported === 'test') return true;
    return ctx.decls.get(target.text)?.declarative === true;
  }
  return false;
}

function classHasEffects(declaration: ts.ClassDeclaration | ts.ClassExpression, ctx: EffectContext): boolean {
  if ((ts.getDecorators(declaration) ?? []).length > 0) return true;
  for (const member of declaration.members) {
    if (member.kind === ts.SyntaxKind.ClassStaticBlockDeclaration && containsEffects(member, ctx)) return true;
    if (ts.isPropertyDeclaration(member) && isStatic(member) && member.initializer && containsEffects(member.initializer, ctx)) return true;
    if ((ts.getDecorators(member as unknown as ts.HasDecorators) ?? []).length > 0) return true;
  }
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function containsEffects(node: ts.Node, ctx: EffectContext): boolean {
  if (ts.isCallExpression(node) && !isRecognizedCallee(node.expression, ctx)) return true;
  if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isAwaitExpression(node) || ts.isDeleteExpression(node)) return true;
  if (ts.isPostfixUnaryExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) return true;
  if (isFunctionBoundary(node)) {
    return isClassLike(node) && classHasEffects(node, ctx);
  }
  let found = false;
  ts.forEachChild(node, (child: ts.Node): void => {
    if (!found && containsEffects(child, ctx)) found = true;
  });
  return found;
}

function rootOfAccess(expression: ts.Expression): ts.Expression {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return current;
}

function bindingLocalOf(call: ts.CallExpression): string | null {
  let current: ts.Node = call;
  let parent = current.parent;
  while (parent && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent))) {
    current = parent;
    parent = parent.parent;
  }
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === current) {
    const names = bindingIdentifiers(parent.name, new Set<string>());
    return [...names][0] ?? null;
  }
  return null;
}

function analyzeModule(
  filePath: string,
  text: string,
  resolveImport: (importer: string, specifier: string) => string | null,
): ModuleInfo {
  const info: ModuleInfo = {
    path: filePath,
    bindings: [],
    externals: new Map(),
    externalExports: new Set(),
    reExports: [],
    starExports: [],
    listExports: new Map(),
    decls: new Map(),
    effects: false,
    exportsOpaque: false,
    modelIssues: [],
  };
  const ctx: EffectContext = { externals: info.externals, decls: info.decls };
  const pendingDeclarators: ts.VariableDeclaration[] = [];
  const deferredEffectNodes: ts.Node[] = [];
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    info.exportsOpaque = true;
    info.modelIssues.push('parse diagnostics present; module model is partial');
  }

  const registerDecl = (name: string, node: ts.Node, exportNames: string[]): void => {
    const refs = new Set<string>();
    collectRefs(node, refs);
    info.decls.set(name, { name, refs, exportNames, declarative: false });
  };

  const addBinding = (local: string | null, kind: BindingKind, specifier: string, imported: string): void => {
    const resolved = resolveImport(filePath, specifier);
    if (resolved !== null) {
      info.bindings.push({ local, kind, module: resolved, imported });
      return;
    }
    if (local !== null && kind !== 'sideeffect') info.externals.set(local, { module: specifier, imported });
  };

  const visitStatements = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
      if (ts.isImportDeclaration(statement)) {
        const specifier = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
        const clause = statement.importClause;
        if (!clause) {
          addBinding(null, 'sideeffect', specifier, '');
          continue;
        }
        if (clause.name) addBinding(clause.name.text, 'default', specifier, 'default');
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          addBinding(bindings.name.text, 'namespace', specifier, '*');
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            addBinding(element.name.text, 'named', specifier, element.propertyName?.text ?? element.name.text);
          }
        }
        continue;
      }
      if (ts.isImportEqualsDeclaration(statement)) {
        const reference = statement.moduleReference;
        if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
          addBinding(statement.name.text, 'import-equals', reference.expression.text, '*');
        } else {
          const names = new Set<string>();
          collectRefs(reference, names);
          info.decls.set(statement.name.text, {
            name: statement.name.text,
            refs: new Set([...names].slice(0, 1)),
            exportNames: hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? [statement.name.text] : [],
            declarative: false,
          });
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        for (const declarator of statement.declarationList.declarations) {
          pendingDeclarators.push(declarator);
          for (const name of bindingIdentifiers(declarator.name, new Set<string>())) {
            info.decls.set(name, { name, refs: new Set(), exportNames: isExported ? [name] : [], declarative: false });
          }
        }
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
        const clause = statement.exportClause;
        if (specifier !== null) {
          const resolved = resolveImport(filePath, specifier);
          if (resolved !== null) {
            if (clause && ts.isNamedExports(clause)) {
              for (const element of clause.elements) {
                info.reExports.push({ name: element.name.text, module: resolved, imported: element.propertyName?.text ?? element.name.text });
              }
            } else if (clause && ts.isNamespaceExport(clause)) {
              info.reExports.push({ name: clause.name.text, module: resolved, imported: '*' });
            } else if (!clause) {
              info.starExports.push(resolved);
            }
          } else {
            const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
            if (clause && ts.isNamedExports(clause)) {
              for (const element of clause.elements) {
                info.externalExports.add(element.name.text);
              }
              if (relative) info.modelIssues.push(`unresolvable internal re-export specifier '${specifier}'`);
            } else if (clause && ts.isNamespaceExport(clause)) {
              info.externalExports.add(clause.name.text);
              if (relative) info.modelIssues.push(`unresolvable internal re-export specifier '${specifier}'`);
            } else {
              info.exportsOpaque = true;
              if (relative) info.modelIssues.push(`unresolvable internal re-export specifier '${specifier}'`);
              else info.modelIssues.push(`export-star over external specifier '${specifier}' cannot enumerate names`);
            }
          }
          continue;
        }
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            info.listExports.set(element.name.text, element.propertyName?.text ?? element.name.text);
          }
        }
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) {
          info.exportsOpaque = true;
          continue;
        }
        const refs = new Set<string>();
        collectRefs(statement.expression, refs);
        info.decls.set(DEFAULT_DECL_NAME, { name: DEFAULT_DECL_NAME, refs, exportNames: ['default'], declarative: false });
        deferredEffectNodes.push(statement.expression);
        continue;
      }
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        const name = statement.name?.text ?? (isDefault ? DEFAULT_DECL_NAME : null);
        if (name !== null) {
          registerDecl(name, statement, [
            ...(isExported && !isDefault ? [name] : []),
            ...(isDefault ? ['default'] : []),
          ]);
        }
        if (ts.isClassDeclaration(statement)) {
          deferredEffectNodes.push(statement);
          for (const clause of statement.heritageClauses ?? []) {
            for (const type of clause.types) deferredEffectNodes.push(type.expression);
          }
          for (const member of statement.members) {
            if (member.name && ts.isComputedPropertyName(member.name)) deferredEffectNodes.push(member.name.expression);
          }
        }
        continue;
      }
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        registerDecl(statement.name.text, statement, isExported ? [statement.name.text] : []);
        continue;
      }
      if (ts.isEnumDeclaration(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        registerDecl(statement.name.text, statement, isExported ? [statement.name.text] : []);
        for (const member of statement.members) {
          if (member.initializer) deferredEffectNodes.push(member.initializer);
          if (member.name && ts.isComputedPropertyName(member.name)) deferredEffectNodes.push(member.name.expression);
        }
        continue;
      }
      if (ts.isModuleDeclaration(statement)) {
        const name = statement.name.text;
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        registerDecl(name, statement, isExported ? [name] : []);
        info.exportsOpaque = true;
        info.modelIssues.push('namespace/module block treated as opaque');
        if (statement.body) deferredEffectNodes.push(statement.body);
        continue;
      }
      if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue;
      if (ts.isExpressionStatement(statement)) {
        const expression = statement.expression;
        if (ts.isBinaryExpression(expression) && isAssignmentOperator(expression.operatorToken.kind)) {
          const root = rootOfAccess(expression.left);
          if (ts.isIdentifier(root) && (root.text === 'module' || root.text === 'exports')) {
            info.exportsOpaque = true;
            info.modelIssues.push('CommonJS module.exports/exports assignment is opaque');
          }
        }
        deferredEffectNodes.push(statement);
        continue;
      }
      info.effects = true;
    }
  };
  visitStatements([...source.statements]);

  for (const declarator of pendingDeclarators) {
    const refs = new Set<string>();
    collectPatternRefs(declarator.name, refs);
    if (declarator.initializer) collectRefs(declarator.initializer, refs);
    if (declarator.type) collectRefs(declarator.type, refs);
    for (const declName of bindingIdentifiers(declarator.name, new Set<string>())) {
      const decl = info.decls.get(declName);
      if (decl) for (const ref of refs) decl.refs.add(ref);
    }
  }

  const scanModuleCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamic) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          const resolved = resolveImport(filePath, argument.text);
          if (resolved !== null) {
            info.bindings.push({ local: bindingLocalOf(node), kind: isRequire ? 'require' : 'dynamic', module: resolved, imported: '*' });
          } else {
            info.modelIssues.push(`unresolvable ${isRequire ? 'require' : 'dynamic import'} '${argument.text}'`);
          }
        } else if (argument) {
          info.modelIssues.push(`non-literal ${isRequire ? 'require' : 'dynamic import'} cannot be resolved`);
        }
      }
    }
    ts.forEachChild(node, scanModuleCalls);
  };
  scanModuleCalls(source);

  const initializerOf = new Map<string, ts.Expression>();
  for (const declarator of pendingDeclarators) {
    if (!declarator.initializer) continue;
    for (const declName of bindingIdentifiers(declarator.name, new Set<string>())) {
      initializerOf.set(declName, declarator.initializer);
    }
  }

  let declarativeStable = false;
  while (!declarativeStable) {
    declarativeStable = true;
    for (const decl of info.decls.values()) {
      if (decl.declarative) continue;
      const initializer = initializerOf.get(decl.name);
      if (initializer && ts.isCallExpression(initializer) && isRecognizedCallee(initializer.expression, ctx)) {
        decl.declarative = true;
        declarativeStable = false;
        continue;
      }
      if (initializer && ts.isIdentifier(initializer) && info.decls.get(initializer.text)?.declarative) {
        decl.declarative = true;
        declarativeStable = false;
      }
    }
  }

  for (const declarator of pendingDeclarators) {
    if (declarator.initializer && containsEffects(declarator.initializer, ctx)) info.effects = true;
  }
  for (const node of deferredEffectNodes) {
    if (containsEffects(node, ctx)) info.effects = true;
  }
  return info;
}

interface ResolvedModule {
  info: ModuleInfo;
  exportNames: Set<string>;
  exportsOpaque: boolean;
}

function resolveExports(modules: Map<string, ModuleInfo>): Map<string, ResolvedModule> {
  const resolved = new Map<string, ResolvedModule>();
  const compute = (path: string, visiting: Set<string>): ResolvedModule => {
    const cached = resolved.get(path);
    if (cached) return cached;
    const info = modules.get(path);
    if (!info) return { info: null as unknown as ModuleInfo, exportNames: new Set(), exportsOpaque: true };
    if (visiting.has(path)) return { info, exportNames: new Set(), exportsOpaque: true };
    visiting.add(path);
    const names = new Set<string>();
    let opaque = info.exportsOpaque;
    for (const exportName of info.listExports.keys()) names.add(exportName);
    for (const decl of info.decls.values()) for (const exportName of decl.exportNames) names.add(exportName);
    for (const reExport of info.reExports) names.add(reExport.name);
    for (const externalName of info.externalExports) names.add(externalName);
    for (const starSource of info.starExports) {
      const sub = compute(starSource, visiting);
      for (const name of sub.exportNames) if (name !== 'default') names.add(name);
      if (sub.exportsOpaque) opaque = true;
    }
    visiting.delete(path);
    const entry: ResolvedModule = { info, exportNames: names, exportsOpaque: opaque };
    resolved.set(path, entry);
    return entry;
  };
  for (const path of [...modules.keys()].sort()) compute(path, new Set());
  return resolved;
}

interface RevisionAnalysis {
  reached: Set<string>;
  reasons: Map<string, Set<string>>;
  fallbacks: Map<string, Set<string>>;
}

function isOpaqueConsumption(kind: BindingKind): boolean {
  return kind === 'sideeffect' || kind === 'namespace' || kind === 'require' || kind === 'dynamic' || kind === 'import-equals' || kind === 'opaque-edge';
}

function analyzeRevision(
  revision: ContextRevision,
  seedPaths: ReadonlySet<string>,
  seedReasons: ReadonlyMap<string, string>,
): RevisionAnalysis {
  const modules = new Map<string, ModuleInfo>();
  for (const [path, text] of revision.sources) modules.set(path, analyzeModule(path, text, revision.resolveImport));
  const exports = resolveExports(modules);

  const wild = new Set<string>();
  const importTime = new Set<string>();
  const affected = new Map<string, Set<string>>();
  const reachedLocals = new Map<string, Set<string>>();
  const reached = new Set<string>();
  const reasons = new Map<string, Set<string>>();
  const fallbacks = new Map<string, Set<string>>();
  const pendingFallbacks = new Map<string, Set<string>>();

  const addReason = (path: string, reason: string): void => {
    reasons.set(path, new Set([...(reasons.get(path) ?? []), reason]));
  };
  const addFallback = (path: string, reason: string): void => {
    fallbacks.set(path, new Set([...(fallbacks.get(path) ?? []), reason]));
  };
  const queueFallback = (path: string, reason: string): void => {
    pendingFallbacks.set(path, new Set([...(pendingFallbacks.get(path) ?? []), reason]));
  };
  const addAffected = (path: string, exportName: string): void => {
    affected.set(path, new Set([...(affected.get(path) ?? []), exportName]));
  };
  const addLocal = (path: string, local: string): void => {
    reachedLocals.set(path, new Set([...(reachedLocals.get(path) ?? []), local]));
  };
  const markReached = (path: string, reason: string): void => {
    if (!reached.has(path)) {
      for (const issue of pendingFallbacks.get(path) ?? []) addFallback(path, issue);
    }
    reached.add(path);
    addReason(path, reason);
  };

  for (const [path, info] of modules) {
    for (const issue of info.modelIssues) queueFallback(path, issue);
    const covered = new Set<string>();
    for (const binding of info.bindings) covered.add(binding.module);
    for (const reExport of info.reExports) covered.add(reExport.module);
    for (const starSource of info.starExports) covered.add(starSource);
    for (const edge of revision.edges) {
      if (edge.from !== path || covered.has(edge.to)) continue;
      info.bindings.push({ local: null, kind: 'opaque-edge', module: edge.to, imported: '*' });
      queueFallback(path, `file-level edge to ${edge.to} not represented in the AST model`);
    }
  }

  for (const seed of seedPaths) {
    wild.add(seed);
    markReached(seed, seedReasons.get(seed) ?? 'changed');
  }

  const moduleAffected = (path: string): Set<string> => affected.get(path) ?? new Set<string>();
  const isWild = (path: string): boolean => wild.has(path);
  const consumesAffected = (modulePath: string, imported: string): boolean => {
    if (isWild(modulePath)) return true;
    const names = moduleAffected(modulePath);
    if (names.size === 0) return false;
    const module = exports.get(modulePath);
    if (module === undefined || module.exportsOpaque) return true;
    return names.has(imported);
  };
  const bindingReached = (modulePath: string, binding: Binding): boolean => {
    if (isWild(modulePath)) return true;
    const names = moduleAffected(modulePath);
    if (names.size === 0) return false;
    const module = exports.get(modulePath);
    if (module === undefined || module.exportsOpaque) return true;
    if (binding.kind === 'named' || binding.kind === 'default') return names.has(binding.imported);
    return true;
  };
  const allExportsAffected = (path: string): boolean => {
    const module = exports.get(path);
    if (!module) return false;
    let mutated = false;
    for (const name of module.exportNames) {
      if (!moduleAffected(path).has(name)) {
        addAffected(path, name);
        mutated = true;
      }
    }
    return mutated;
  };
  const propagateLocals = (path: string): Set<string> => {
    const info = modules.get(path);
    const locals = new Set(reachedLocals.get(path) ?? []);
    if (!info) return locals;
    let stable = false;
    while (!stable) {
      stable = true;
      for (const decl of info.decls.values()) {
        if (locals.has(decl.name)) continue;
        if ([...decl.refs].some((ref: string): boolean => locals.has(ref))) {
          locals.add(decl.name);
          stable = false;
        }
      }
    }
    return locals;
  };

  let stable = false;
  while (!stable) {
    stable = true;
    const note = (mutated: boolean): void => {
      if (mutated) stable = false;
    };
    const broaden = (path: string, reason: string): void => {
      if (wild.has(path)) return;
      wild.add(path);
      note(true);
      addFallback(path, reason);
      note(allExportsAffected(path));
    };
    for (const path of [...modules.keys()].sort()) {
      const info = modules.get(path) as ModuleInfo;
      for (const binding of info.bindings) {
        if (!bindingReached(binding.module, binding)) continue;
        const before = reached.has(path);
        markReached(path, `caller of ${binding.module}${binding.imported !== '*' && binding.imported ? ` via '${binding.imported}'` : ''}`);
        note(!before);
        if (binding.kind === 'named' || binding.kind === 'default') {
          addLocal(path, binding.local as string);
        } else {
          const kindLabels: Record<string, string> = {
            sideeffect: 'side-effect import',
            namespace: 'namespace import',
            require: 'require() call',
            dynamic: 'dynamic import()',
            'import-equals': 'import-equals',
            'opaque-edge': 'unmodeled file-level edge',
          };
          const label = kindLabels[binding.kind] ?? `${binding.kind} import`;
          broaden(path, `${label} of ${binding.module} requires broad downstream reachability`);
        }
      }
      for (const reExport of info.reExports) {
        const hits = reExport.imported === '*'
          ? isWild(reExport.module) || moduleAffected(reExport.module).size > 0
          : consumesAffected(reExport.module, reExport.imported);
        if (!hits) continue;
        const had = moduleAffected(path).has(reExport.name);
        addAffected(path, reExport.name);
        markReached(path, `re-export of ${reExport.module} '${reExport.imported}'`);
        note(!had);
        if (reExport.imported === '*') addFallback(path, `namespace re-export of ${reExport.module}`);
      }
      for (const starSource of info.starExports) {
        const sourceModule = exports.get(starSource);
        if (!sourceModule) continue;
        const starNames = new Set([...sourceModule.exportNames].filter((name: string): boolean => name !== 'default'));
        if (isWild(starSource)) {
          const before = moduleAffected(path).size;
          for (const name of starNames) addAffected(path, name);
          markReached(path, `export-star chain through ${starSource}`);
          note(moduleAffected(path).size !== before);
          continue;
        }
        const names = moduleAffected(starSource);
        for (const name of starNames) {
          if (!names.has(name)) continue;
          const had = moduleAffected(path).has(name);
          addAffected(path, name);
          markReached(path, `export-star chain through ${starSource}`);
          note(!had);
        }
      }
      const locals = propagateLocals(path);
      const exportTargets = new Map<string, string>();
      for (const [exportName, localName] of info.listExports) exportTargets.set(exportName, localName);
      for (const decl of info.decls.values()) {
        for (const exportName of decl.exportNames) exportTargets.set(exportName, decl.name);
      }
      for (const [exportName, localName] of exportTargets) {
        if (!locals.has(localName)) continue;
        const had = moduleAffected(path).has(exportName);
        addAffected(path, exportName);
        note(!had);
      }
      const taintSources = new Set<string>();
      for (const binding of info.bindings) {
        if (importTime.has(binding.module)) taintSources.add(binding.module);
        else if (binding.kind === 'sideeffect' && (isWild(binding.module) || moduleAffected(binding.module).size > 0)) taintSources.add(binding.module);
      }
      for (const reExport of info.reExports) {
        if (importTime.has(reExport.module)) taintSources.add(reExport.module);
      }
      for (const starSource of info.starExports) {
        if (importTime.has(starSource)) taintSources.add(starSource);
      }
      if (taintSources.size > 0 && !importTime.has(path)) {
        importTime.add(path);
        note(true);
        markReached(path, `import-time reachability through ${[...taintSources].sort().join(', ')}`);
        addFallback(path, `import-time effects reachable through ${[...taintSources].sort().join(', ')}`);
      }
      if (reached.has(path) && !importTime.has(path)) {
        const module = exports.get(path);
        if (info.effects || module?.exportsOpaque || info.modelIssues.length > 0) {
          importTime.add(path);
          note(true);
          addFallback(path, 'import-time effects or opaque model taint downstream evaluation');
        }
      }
      if (reached.has(path) && !wild.has(path)) {
        const module = exports.get(path);
        if (info.effects) broaden(path, 'import-time executable code prevents named narrowing');
        else if (module?.exportsOpaque) broaden(path, 'opaque or unenumerable exports prevent named narrowing');
        else if (info.modelIssues.length > 0) broaden(path, 'partial module model prevents named narrowing');
      }
    }
  }

  return { reached, reasons, fallbacks };
}

export function planReviewContext(input: ContextPlannerInput): ContextPlannerResult {
  const seedPaths = new Set<string>();
  const seedReasons = new Map<string, string>();
  for (const change of input.changes) {
    seedPaths.add(change.path);
    seedReasons.set(change.path, 'changed');
    if (change.previousPath) {
      seedPaths.add(change.previousPath);
      seedReasons.set(change.previousPath, 'changed-previous-path');
    }
  }

  const selected = new Set<string>([...seedPaths, ...input.additionalContextPaths]);
  const reasons = new Map<string, Set<string>>();
  const fallbacks = new Map<string, Set<string>>();
  const addReason = (path: string, reason: string): void => {
    reasons.set(path, new Set([...(reasons.get(path) ?? []), reason]));
  };
  const addFallback = (path: string, reason: string): void => {
    fallbacks.set(path, new Set([...(fallbacks.get(path) ?? []), reason]));
  };
  for (const [path, reason] of seedReasons) addReason(path, reason);
  for (const path of input.additionalContextPaths) addReason(path, 'prior-finding-context');

  for (const revision of input.revisions) {
    const analysis = analyzeRevision(revision, seedPaths, seedReasons);
    for (const path of analysis.reached) selected.add(path);
    for (const [path, list] of analysis.reasons) for (const reason of list) addReason(path, reason);
    for (const [path, list] of analysis.fallbacks) for (const reason of list) addFallback(path, reason);
  }

  const forward = new Map<string, string[]>();
  for (const revision of input.revisions) {
    for (const edge of revision.edges) forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.to]);
  }
  const queue = [...selected];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of forward.get(current) ?? []) {
      if (!selected.has(next)) {
        selected.add(next);
        addReason(next, 'forward-dependency');
        queue.push(next);
      }
    }
  }

  const edgeSeen = new Set<string>();
  const dependencyEdges: DependencyEdge[] = [];
  for (const revision of input.revisions) {
    for (const edge of revision.edges) {
      const key = `${edge.from}>${edge.to}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      if (selected.has(edge.from) && selected.has(edge.to)) dependencyEdges.push(edge);
    }
  }
  dependencyEdges.sort((left: DependencyEdge, right: DependencyEdge): number => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  const selections = [...selected].sort().map((path: string): { path: string; reasons: string[] } => ({
    path,
    reasons: [...(reasons.get(path) ?? ['selected'])].sort(),
  }));
  const fallbackEntries: { path: string; reason: string }[] = [];
  for (const [path, list] of fallbacks) {
    for (const reason of [...list].sort()) fallbackEntries.push({ path, reason });
  }
  fallbackEntries.sort((left: { path: string; reason: string }, right: { path: string; reason: string }): number =>
    left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));

  return {
    selectedPaths: selections.map((selection: { path: string; reasons: string[] }): string => selection.path),
    dependencyEdges,
    evidence: {
      strategy: 'symbol-aware-reverse-v1',
      selections,
      fallbacks: fallbackEntries,
    },
  };
}
