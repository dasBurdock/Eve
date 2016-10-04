//-----------------------------------------------------------
// Parser
//-----------------------------------------------------------

import * as commonmark from "commonmark";
import * as chev from "chevrotain";
import * as join from "./join";
import {buildDoc} from "./builder";
import {inspect} from "util"
import {time} from "./performance";
var {Lexer} = chev;
var Token = chev.Token;

//-----------------------------------------------------------
// Utils
//-----------------------------------------------------------

function cleanString(str) {
  let cleaned = str
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, "\"")
    .replace(/\\{/g, "{")
    .replace(/\\}/g, "}");
  return cleaned;
}

//-----------------------------------------------------------
// Markdown
//-----------------------------------------------------------

let markdownParser = new commonmark.Parser();

function parseMarkdown(markdown: string, docId: string) {
  let parsed = markdownParser.parse(markdown);
  let walker = parsed.walker();
  var cur;
  let tokenId = 0;
  var text = [];
  var extraInfo = {};
  var pos = 0;
  var lastLine = 1;
  var spans = [];
  var context = [];
  var blocks = [];
  while(cur = walker.next()) {
    let node = cur.node;
    if(cur.entering) {
      while(node.sourcepos && node.sourcepos[0][0] > lastLine) {
        lastLine++;
        pos++;
        text.push("\n");
      }
      if(node.type !== "text") {
        context.push({node, start: pos});
      }
      if(node.type == "text" || node.type === "code_block" || node.type == "code") {
        text.push(node.literal);
        pos += node.literal.length;
      }
      if(node.type == "softbreak") {
        text.push("\n");
        pos += 1;
        lastLine++;
        context.pop();
      }
      if(node.type == "code_block") {
        let spanId = `${docId}|${tokenId++}|block`;
        let start = context.pop().start;
        node.id = spanId;
        node.startOffset = start;
        spans.push(start, pos, node.type, spanId);
        blocks.push(node);
        lastLine = node.sourcepos[1][0] + 1;
      }
      if(node.type == "code") {
        let spanId = `${docId}|${tokenId++}`;
        let start = context.pop().start;
        spans.push(start, pos, node.type, spanId);
      }
    } else {
      let info = context.pop();
      if(node !== info.node) {
        throw new Error("Common mark is exiting a node that doesn't agree with the context stack");
      }
      if(node.type == "emph" || node.type == "strong" || node.type == "link") {
        let spanId = `${docId}|${tokenId++}`;
        spans.push(info.start, pos, node.type, spanId);
        if(node.type === "link") {
          extraInfo[spanId] = {destination: node._destination};
        }
      } else if(node.type == "heading" || node.type == "item") {
        let spanId = `${docId}|${tokenId++}`;
        spans.push(info.start, info.start, node.type, spanId);
        extraInfo[spanId] = {level: node._level, listData: node._listData};
      }
    }
  }
  return {text: text.join(""), spans, blocks, extraInfo};
}

//-----------------------------------------------------------
// Tokens
//-----------------------------------------------------------

const breakChars = "@#\\.,\\(\\)\\[\\]{}⦑⦒:\\\"";

// Markdown
class DocContent extends Token { static PATTERN = /[^\n]+/; }
class Fence extends Token {
  static PATTERN = /```|~~~/;
  static PUSH_MODE = "code";
}
class CloseFence extends Token {
  static PATTERN = /```|~~~/;
  static POP_MODE = true;
}

// Comments
class CommentLine extends Token { static PATTERN = /\/\/.*\n/; label = "comment"; }

// Operators
class Equality extends Token { static PATTERN = /:|=/; label = "equality"; }
class Comparison extends Token { static PATTERN = />=|<=|!=|>|</; label = "comparison"; }
class AddInfix extends Token { static PATTERN = /\+|-/; label = "infix"; }
class MultInfix extends Token { static PATTERN = /\*|\//; label = "infix"; }
class Merge extends Token { static PATTERN = /<-/; label = "merge"; }
class Set extends Token { static PATTERN = /:=/; label = "set"; }
class Mutate extends Token { static PATTERN = /\+=|-=/; label = "mutate"; }
class Dot extends Token { static PATTERN = /\./; label = "dot"; }
class Pipe extends Token { static PATTERN = /\|/; label = "pipe"; }

// Identifier
class Identifier extends Token { static PATTERN = new RegExp(`[\\+-/\\*][^\\s${breakChars}]+|[^\\d${breakChars}\\+-/\\*][^\\s${breakChars}]*`); label = "identifier"; }

// Keywords
class Keyword extends Token {
    static PATTERN = Lexer.NA;
    static LONGER_ALT = Identifier;
}
class Action extends Keyword { static PATTERN = /bind|commit/; label = "action"; }
class Match extends Keyword { static PATTERN = /match/; label = "match"; }
class Is extends Keyword { static PATTERN = /is/; label = "is"; }
class If extends Keyword { static PATTERN = /if/; label = "if"; }
class Else extends Keyword { static PATTERN = /else/; label = "else"; }
class Then extends Keyword { static PATTERN = /then/; label = "then"; }
class Not extends Keyword { static PATTERN = /not/; label = "not"; }

// Values
class Bool extends Keyword { static PATTERN = /true|false/; label = "bool"; }
class Num extends Token { static PATTERN = /-?\d+(\.\d+)?/; label = "num"; }
class None extends Keyword { static PATTERN = /none/; label = "none"; }
class Name extends Token { static PATTERN = /@/; label = "name"; }
class Tag extends Token { static PATTERN = /#/; label = "tag"; }
class Uuid extends Token { static PATTERN = /⦑.*⦒/; label = "uuid"; }

// Delimiters
class OpenBracket extends Token { static PATTERN = /\[/; label = "open-bracket"; }
class CloseBracket extends Token { static PATTERN = /\]/; label = "close-bracket"; }
class OpenParen extends Token { static PATTERN = /\(/; label = "open-paren"; }
class CloseParen extends Token { static PATTERN = /\)/; label = "close-paren"; }

// Strings
class StringChars extends Token { static PATTERN = /(\\.|{(?=[^{])|[^"\\{])+/; label = "string"; }
class StringOpen extends Token {
  static PATTERN = /"/;
  static PUSH_MODE = "string";
  label = "quote";
}
class StringClose extends Token {
  static PATTERN = /"/;
  static POP_MODE = true;
  label = "quote";
}

// String Embeds
class StringEmbedOpen extends Token {
  static PATTERN = /{{/;
  static PUSH_MODE = "code";
  label = "string-embed-open";
}
class StringEmbedClose extends Token {
  static PATTERN = /}}/;
  static POP_MODE = true;
  label = "string-embed-close";
}

// Whitespace
class WhiteSpace extends Token {
  static PATTERN = /\s+|,/;
  static GROUP = Lexer.SKIPPED;
}

//-----------------------------------------------------------
// Lexers
//-----------------------------------------------------------

let codeTokens: any[] = [
  CloseFence, WhiteSpace, CommentLine, OpenBracket, CloseBracket, OpenParen,
  CloseParen, StringEmbedClose, StringOpen, Bool, Action, Set, Equality, Dot, Pipe, Merge,
  Mutate, Comparison, Num,  Match, Is, If, Else, Then,
  Not, None, Name, Tag, Uuid, Identifier, AddInfix, MultInfix
];

let stringEmbedTokens: any[] = [StringEmbedClose].concat(codeTokens);

let LexerModes:any = {
  "doc": [WhiteSpace, Fence, DocContent],
  "code": codeTokens,
  "string": [StringClose, StringEmbedOpen, StringChars],
  // "stringEmbed": stringEmbedTokens,
};

let allTokens: any[] = codeTokens.concat([Fence, DocContent, StringClose, StringEmbedOpen, StringEmbedClose, StringChars]);

let EveDocLexer = new Lexer({modes: LexerModes, defaultMode: "doc"}, true);
let EveBlockLexer = new Lexer({modes: LexerModes, defaultMode: "code"}, true);

//-----------------------------------------------------------
// Parse Nodes
//-----------------------------------------------------------

export type NodeDependent = chev.Token | ParseNode;

export interface ParseNode {
  type?: string
  id?: string
  from: NodeDependent[]
  [property: string]: any
}

export class ParseBlock {
  id: string;
  nodeId = 0;
  variables: {[name: string]: ParseNode} = {};
  equalities: any[] = [];
  scanLike: ParseNode[] = [];
  expressions: ParseNode[] = [];
  binds: ParseNode[] = [];
  commits: ParseNode[] = [];
  variableLookup: {[name: string]: ParseNode};

  constructor(id, variableLookup?) {
    this.id = id;
    this.variableLookup = variableLookup || {};
  }

  toVariable(name, generated = false) {
    let variable = this.variableLookup[name];
    if(!variable) {
      this.variableLookup[name] = this.makeNode("variable", {name, from: [], generated});
    }
    variable = this.variables[name] = this.variableLookup[name];
    return variable;
  }

  equality(a, b) {
    this.equalities.push([a, b]);
  }

  commit(node: ParseNode) {
    this.commits.push(node);
  }

  bind(node: ParseNode) {
    this.binds.push(node);
  }

  expression(node: ParseNode) {
    this.expressions.push(node);
  }

  scan(node: ParseNode) {
    this.scanLike.push(node);
  }

  makeNode(type, node: ParseNode) {
    if(!node.id) {
      node.id = `${this.id}|${this.nodeId++}`;
    }
    node.type = type;
    return node;
  }

  subBlock() {
    let neue = new ParseBlock(`${this.id}|sub${this.nodeId++}`, this.variableLookup);
    return neue;
  }
}


//-----------------------------------------------------------
// Parser
//-----------------------------------------------------------

class Parser extends chev.Parser {
  block: ParseBlock;
  activeScopes: string[];

  // Parser patterns
  doc: any;
  codeBlock: any;
  fencedBlock: any;
  section: any;
  matchSection: any;
  actionSection: any;
  value: any;
  bool: any;
  num: any;
  scopeDeclaration: any;
  name: any;
  statement: any;
  expression: any;
  attribute: any;
  attributeEquality: any;
  attributeComparison: any;
  attributeNot: any;
  attributeOperation: any;
  record: any;
  tag: any;
  functionRecord: any;
  notStatement: any;
  comparison: any;
  infix: any;
  attributeAccess: any;
  actionStatement: any;
  actionEqualityRecord: any;
  actionAttributeExpression: any;
  actionOperation: any;
  variable: any;
  recordOperation: any;
  ifExpression: any;
  ifBranch: any;
  elseIfBranch: any;
  elseBranch: any;
  multiplication: any;
  addition: any;
  infixValue: any;
  parenthesis: any;
  attributeMutator: any;
  singularAttribute: any;
  stringInterpolation: any;
  isExpression: any;


  constructor(input) {
    super(input, allTokens, {recoveryEnabled: false});
    let self = this;
    let rule = (name, func) => {
      self[name] = self.RULE(name, func);
    }
    let asValue = (node) => {
      if(node.type === "constant" || node.type === "variable" || node.type === "parenthesis") {
        return node;
      } else if(node.variable) {
        return node.variable;
      }
      throw new Error("Tried to get value of a node that is neither a constant nor a variable.\n\n" + inspect(node));
    }
    let ifOutputs = (expression) => {
      let outputs = [];
      if(expression.type === "parenthesis") {
        for(let item of expression.items) {
          outputs.push(asValue(item));
        }
      } else {
        outputs.push(asValue(expression));
      }
      return outputs;
    }

    let makeNode = (type, node) => {
      return self.block.makeNode(type, node);
    }

    let blockStack = [];
    let pushBlock = (blockId?) => {
      let block;
      let prev = blockStack[blockStack.length - 1];
      if(prev) {
        block = prev.subBlock();
      } else {
        block = new ParseBlock(blockId || "block");
      }
      blockStack.push(block);
      self.block = block;
      return block;
    }

    let popBlock = () => {
      let popped = blockStack.pop();
      self.block = blockStack[blockStack.length - 1];
      return popped;
    }

    //-----------------------------------------------------------
    // Doc rules
    //-----------------------------------------------------------

    rule("doc", () => {
      let doc = {
        full: [],
        content: [],
        blocks: [],
      }
      self.MANY(() => {
        self.OR([
          {ALT: () => {
            let content = self.CONSUME(DocContent);
            doc.full.push(content);
            doc.content.push(content);
          }},
          {ALT: () => {
            let block : any = self.SUBRULE(self.fencedBlock);
            if(doc.content.length) {
              block.name = doc.content[doc.content.length - 1].image;
            } else {
              block.name = "Unnamed block";
            }
            doc.full.push(block);
            doc.blocks.push(block);
          }},
        ])
      });
      return doc;
    });

    rule("fencedBlock", () => {
      self.CONSUME(Fence);
      let block = self.SUBRULE(self.codeBlock);
      let fence = self.CONSUME(CloseFence);
      return block;
    });

    //-----------------------------------------------------------
    // Blocks
    //-----------------------------------------------------------

    rule("codeBlock", (blockId = "block") => {
      let block = pushBlock(blockId);
      self.MANY(() => { self.SUBRULE(self.section) })
      return popBlock();
    })

    rule("section", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.matchSection) }},
        {ALT: () => { return self.SUBRULE(self.actionSection) }},
        {ALT: () => { return self.CONSUME(CommentLine); }},
      ]);
    });


    //-----------------------------------------------------------
    // Scope declaration
    //-----------------------------------------------------------

    rule("scopeDeclaration", () => {
      let scopes = [];
      self.OR([
        {ALT: () => {
          self.CONSUME(OpenParen);
          self.AT_LEAST_ONE(() => {
            let name: any = self.SUBRULE(self.name);
            scopes.push(name.name);
          })
          self.CONSUME(CloseParen);
        }},
        {ALT: () => {
          let name: any = self.SUBRULE2(self.name);
          scopes.push(name.name);
        }},
      ]);
      return scopes;
    });


    //-----------------------------------------------------------
    // Match section
    //-----------------------------------------------------------

    rule("matchSection", () => {
      self.CONSUME(Match);
      let scopes:any = ["session"];
      self.OPTION(() => { scopes = self.SUBRULE(self.scopeDeclaration) })
      self.activeScopes = scopes;
      let statements = [];
      self.MANY(() => {
        let statement: any = self.SUBRULE(self.statement);
        if(statement) {
          statements.push(statement);
          statement.scopes = scopes;
        }
      });
      return {type: "matchSection", statements, scopes};
    });

    rule("statement", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.comparison); }},
        {ALT: () => { return self.SUBRULE(self.notStatement); }},
        {ALT: () => { return self.CONSUME(CommentLine); }},
      ])
    });

    //-----------------------------------------------------------
    // Action section
    //-----------------------------------------------------------

    rule("actionSection", () => {
      let action = self.CONSUME(Action).image;
      let actionKey = action;
      let scopes:any = ["session"];
      self.OPTION(() => { scopes = self.SUBRULE(self.scopeDeclaration) })
      self.activeScopes = scopes;
      let statements = [];
      self.MANY(() => {
        let statement = self.SUBRULE(self.actionStatement, [actionKey]) as any;
        if(statement) {
          statements.push(statement);
          statement.scopes = scopes;
        }
      });
      return {type: "actionSection", statements, scopes};
    });


    rule("actionStatement", (actionKey) => {
      return self.OR([
        {ALT: () => {
          let record = self.SUBRULE(self.record, [false, actionKey, "+="]);
          return record;
        }},
        {ALT: () => { return self.SUBRULE(self.actionEqualityRecord, [actionKey]); }},
        {ALT: () => {
          let record = self.SUBRULE(self.actionOperation, [actionKey]);
          self.block[actionKey](record);
          return record;
        }},
        {ALT: () => { return self.CONSUME(CommentLine); }},
      ])
    });

    //-----------------------------------------------------------
    // Action operations
    //-----------------------------------------------------------

    rule("actionOperation", (actionKey) => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.recordOperation, [actionKey]) }},
        {ALT: () => { return self.SUBRULE(self.attributeOperation, [actionKey]) }},
      ]);
    });

    rule("attributeOperation", (actionKey) => {
      let mutator = self.SUBRULE(self.attributeMutator) as any;
      let {attribute, parent} = mutator;
      return self.OR([
        {ALT: () => {
          let variable = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
          let scan = makeNode("scan", {entity: parent, attribute: makeNode("constant", {value: attribute.name, from: [attribute]}), value: variable, scopes: self.activeScopes, from: [mutator]});
          variable.from.push(scan);
          self.block.scan(scan);
          self.CONSUME(Merge);
          let record = self.SUBRULE(self.record, [true]) as any;
          record.variable = variable;
          record.action = "<-";
          return record;
        }},
        {ALT: () => {
          let op = self.CONSUME(Set);
          let none = self.CONSUME(None);
          return makeNode("action", {action: "erase", entity: asValue(parent), attribute: attribute.image, from: [mutator, op, none]});
        }},
        {ALT: () => {
          let op = self.CONSUME2(Set);
          let value = self.SUBRULE(self.infix);
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
        {ALT: () => {
          let op = self.CONSUME3(Set);
          let value = self.SUBRULE2(self.record, [false, actionKey, "+="]);
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
        {ALT: () => {
          let op = self.CONSUME(Mutate);
          let value = self.SUBRULE2(self.actionAttributeExpression, [actionKey, op.image]);
          return makeNode("action", {action: op.image, entity: asValue(parent), attribute: attribute.image, value: asValue(value), from: [mutator, op, value]});
        }},
      ])
    });

    rule("recordOperation", () => {
      let variable = self.SUBRULE(self.variable) as any;
      return self.OR([
        {ALT: () => {
          let set = self.CONSUME(Set);
          let none = self.CONSUME(None);
          return makeNode("action", {action: "erase", entity: asValue(variable), from: [variable, set, none]});
        }},
        {ALT: () => {
          self.CONSUME(Merge);
          let record = self.SUBRULE(self.record, [true]) as any;
          record.needsEntity = true;
          record.variable = variable;
          variable.nonProjecting = true;
          record.action = "<-";
          return record;
        }},
        {ALT: () => {
          let op = self.CONSUME(Mutate);
          let tag : any = self.SUBRULE(self.tag);
          return makeNode("action", {action: op.image, entity: asValue(variable), attribute: "tag", value: makeNode("constant", {value: tag.tag, from: [tag]}), from: [variable, op, tag]});
        }},
        {ALT: () => {
          let op = self.CONSUME2(Mutate);
          let name : any = self.SUBRULE(self.name);
          return makeNode("action", {action: op.image, entity: asValue(variable), attribute: "name", value: makeNode("constant", {value: name.name, from: [name]}), from: [variable, op, name]});
        }},
      ])
    });

    rule("actionAttributeExpression", (actionKey, action) => {
      return self.OR([
        {ALT: () => { return self.CONSUME(None); }},
        {ALT: () => { return self.SUBRULE(self.tag); }},
        {ALT: () => { return self.SUBRULE(self.name); }},
        {ALT: () => { return self.SUBRULE(self.record, [false, actionKey, action]); }},
        {ALT: () => { return self.SUBRULE(self.infix); }},
      ])
    })

    rule("actionEqualityRecord", (actionKey) => {
      let variable = self.SUBRULE(self.variable);
      self.CONSUME(Equality);
      let record : any = self.SUBRULE(self.record, [true, actionKey, "+="]);
      record.variable = variable;
      self.block[actionKey](record);
      return record;
    });

    //-----------------------------------------------------------
    // Record + attribute
    //-----------------------------------------------------------

    rule("record", (noVar = false, blockKey = "scan", action = false, parent?) => {
      let attributes = [];
      let start = self.CONSUME(OpenBracket);
      let from: NodeDependent[] = [start];
      let record : any = makeNode("record", {attributes, action, scopes: self.activeScopes, from});
      if(parent) {
        record.extraProjection = [parent];
      }
      if(!noVar) {
        record.variable = self.block.toVariable(`record|${start.startLine}|${start.startColumn}`, true);
        record.variable.nonProjecting = true;
      }
      let nonProjecting = false;
      self.MANY(() => {
        self.OR([
          {ALT: () => {
            let attribute: any = self.SUBRULE(self.attribute, [false, blockKey, action, record.variable]);
            // Inline handles attributes itself and so won't return any attribute for us to add
            // to this object
            if(!attribute) return;

            if(attribute.constructor === Array) {
              for(let attr of attribute as any[]) {
                attr.nonProjecting = nonProjecting;
                attributes.push(attr);
                from.push(attr);
              }
            } else {
              attribute.nonProjecting = nonProjecting;
              attributes.push(attribute);
              from.push(attribute);
            }
          }},
          {ALT: () => {
            nonProjecting = true;
            let pipe = self.CONSUME(Pipe);
            from.push(pipe);
            return pipe;
          }},
        ]);
      })
      from.push(self.CONSUME(CloseBracket));
      if(!noVar) {
        self.block[blockKey](record);
      }
      return record;
    });

    rule("attribute", (noVar, blockKey, action, recordVariable) => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeEquality, [noVar, blockKey, action, recordVariable]); }},
        {ALT: () => { return self.SUBRULE(self.attributeComparison); }},
        {ALT: () => { return self.SUBRULE(self.attributeNot, [recordVariable]); }},
        {ALT: () => { return self.SUBRULE(self.singularAttribute); }},
      ]);
    });

    rule("singularAttribute", (forceGenerate) => {
      return self.OR([
        {ALT: () => {
          let name : any = self.SUBRULE(self.name);
          return makeNode("attribute", {attribute: "name", value: makeNode("constant", {value: name.name, from: [name]}), from: [name]});
        }},
        {ALT: () => {
          let tag : any = self.SUBRULE(self.tag);
          return makeNode("attribute", {attribute: "tag", value: makeNode("constant", {value: tag.tag, from: [tag]}), from: [tag]});
        }},
        {ALT: () => {
          let variable : any = self.SUBRULE(self.variable, [forceGenerate]);
          return makeNode("attribute", {attribute: variable.name, value: variable, from: [variable]});
        }},
      ]);
    });

    rule("attributeMutator", () => {
      let scans = [];
      let entity, attribute, value;
      let needsEntity = true;
      let from = [];
      entity = self.SUBRULE(self.variable);
      let dot = self.CONSUME(Dot);
      from.push(entity, dot);
      self.MANY(() => {
        attribute = self.CONSUME(Identifier);
        from.push(attribute);
        from.push(self.CONSUME2(Dot));
        value = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
        value.from.push(attribute);
        let scan = makeNode("scan", {entity, attribute: makeNode("constant", {value: value.name, from: [value]}), value, needsEntity, scopes: self.activeScopes, from: [entity, dot, attribute]});
        self.block.scan(scan);
        needsEntity = false;
        entity = value;
      });
      attribute = self.CONSUME2(Identifier);
      from.push(attribute);
      return makeNode("attributeMutator", {attribute: attribute, parent: entity, from});
    });

    rule("attributeAccess", () => {
      let scans = [];
      let entity, attribute, value;
      let needsEntity = true;
      entity = self.SUBRULE(self.variable);
      self.AT_LEAST_ONE(() => {
        let dot = self.CONSUME(Dot);
        attribute = self.CONSUME(Identifier);
        value = self.block.toVariable(`${attribute.image}|${attribute.startLine}|${attribute.startColumn}`, true);
        value.from.push(attribute);
        let scan = makeNode("scan", {entity, attribute: makeNode("constant", {value: attribute.image, from: [attribute]}), value, needsEntity, scopes: self.activeScopes, from: [entity, dot, attribute]});
        self.block.scan(scan);
        needsEntity = false;
        entity = value;
      });
      return value;
    });

    rule("attributeEquality", (noVar, blockKey, action, parent) => {
      let attributes = [];
      let autoIndex = 1;
      let attributeNode;
      let attribute: any = self.OR([
        {ALT: () => {
          attributeNode = self.CONSUME(Identifier);
          return attributeNode.image;
        }},
        {ALT: () => {
          attributeNode = self.CONSUME(Num);
          return parseFloat(attributeNode.image) as any;
        }}
      ]);
      let equality = self.CONSUME(Equality);
      let result : any;
      self.OR2([
        {ALT: () => {
          result = self.SUBRULE(self.infix);
        }},
        {ALT: () => {
          result = self.SUBRULE(self.record, [noVar, blockKey, action, parent]);
          self.MANY(() => {
            autoIndex++;
            let record : any = self.SUBRULE2(self.record, [noVar, blockKey, action, parent]);
            record.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: autoIndex, from: []}), from: []}));
            attributes.push(makeNode("attribute", {attribute, value: asValue(record), from: [attribute, equality, record]}));
          })
          if(autoIndex > 1) {
            result.attributes.push(makeNode("attribute", {attribute: "eve-auto-index", value: makeNode("constant", {value: 1, from: []}), from: []}));
          }
        }},
      ]);
      attributes.push(makeNode("attribute", {attribute, value: asValue(result), from: [attributeNode, equality, result]}))
      return attributes;
    });

    rule("attributeComparison", () => {
      let attribute = self.CONSUME(Identifier);
      let comparator = self.CONSUME(Comparison);
      let result = self.SUBRULE(self.expression);
      let variable = self.block.toVariable(`attribute|${attribute.startLine}|${attribute.startColumn}`, true);
      let expression = makeNode("expression", {op: comparator.image, args: [asValue(variable), asValue(result)], from: [attribute, comparator, result]})
      variable.from.push(expression);
      self.block.expression(expression);
      return makeNode("attribute", {attribute: attribute.image, value: variable, from: [attribute, comparator, expression]});
    });

    rule("attributeNot", (recordVariable) => {
      let block = pushBlock();
      block.type = "not";
      let not = self.CONSUME(Not);
      let start = self.CONSUME(OpenParen);
      let attribute: any = self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeComparison); }},
        {ALT: () => { return self.SUBRULE(self.singularAttribute, [true]); }},
      ]);
      let end = self.CONSUME(CloseParen);
      // we have to add a record for this guy
      let scan : any = makeNode("scan", {entity: recordVariable, attribute: makeNode("constant", {value: attribute.attribute, from: [attribute]}), value: attribute.value, needsEntity: true, scopes: self.activeScopes, from: [attribute]});
      block.variables[recordVariable.name] = recordVariable;
      block.scan(scan);
      block.from = [not, start, attribute, end];
      popBlock();
      self.block.scan(block);
      return;
    });

    //-----------------------------------------------------------
    // Name and tag
    //-----------------------------------------------------------

    rule("name", () => {
      let at = self.CONSUME(Name);
      let name = self.CONSUME(Identifier);
      return makeNode("name", {name: name.image, from: [at, name]});
    });

    rule("tag", () => {
      let hash = self.CONSUME(Tag);
      let tag = self.CONSUME(Identifier);
      return makeNode("tag", {tag: tag.image, from: [hash, tag]});
    });

    //-----------------------------------------------------------
    // Function
    //-----------------------------------------------------------

    rule("functionRecord", (): any => {
      let name = self.CONSUME(Identifier);
      let record: any = self.SUBRULE(self.record, [true]);
      if(name.image === "lookup") {
        let info: any = {};
        for(let attribute of record.attributes) {
          info[attribute.attribute] = attribute.value;
        }
        let scan = makeNode("scan", {entity: info.record, attribute: info.attribute, value: info.value, node: info.node, scopes: self.activeScopes, from: [name, record]});
        self.block.scan(scan);
        return scan;
      } else {
        let variable = self.block.toVariable(`return|${name.startLine}|${name.startColumn}`, true);
        let functionRecord = makeNode("functionRecord", {op: name.image, record, variable, from: [name, record]});
        variable.from.push(functionRecord);
        self.block.expression(functionRecord);
        return functionRecord;
      }
    });

    //-----------------------------------------------------------
    // Comparison
    //-----------------------------------------------------------

    rule("comparison", (nonFiltering) : any => {
      let left = self.SUBRULE(self.expression);
      let from = [left];
      let rights = [];
      self.MANY(() => {
        let comparator = self.OR([
          {ALT: () => { return self.CONSUME(Comparison); }},
          {ALT: () => { return self.CONSUME(Equality); }}
        ]);
        let value = self.OR2([
          {ALT: () => { return self.SUBRULE2(self.expression); }},
          {ALT: () => { return self.SUBRULE(self.ifExpression); }}
        ]);
        from.push(comparator, value);
        rights.push({comparator, value});
      })
      if(rights.length) {
        let expressions = [];
        let curLeft: any = left;
        for(let pair of rights) {
          let {comparator, value} = pair;
          let expression = null;
          // if this is a nonFiltering comparison, then we return an expression
          // with a variable for its return value
          if(nonFiltering) {
            let variable = self.block.toVariable(`comparison|${comparator.startLine}|${comparator.startColumn}`, true);
            expression = makeNode("expression", {variable, op: comparator.image, args: [asValue(curLeft), asValue(value)], from: [curLeft, comparator, value]});
            variable.from.push(expression);
            self.block.expression(expression);
          } else if(comparator instanceof Equality) {
            if(value.type === "ifExpression") {
              value.outputs = ifOutputs(left);
              self.block.scan(value);
            } else if(value.type === "functionRecord" && curLeft.type === "parenthesis") {
              value.returns = curLeft.items.map(asValue);
              self.block.equality(asValue(value.returns[0]), asValue(value));
            } else if(curLeft.type === "parenthesis") {
              throw new Error("Left hand parenthesis without an if or function on the right");
            } else {
              self.block.equality(asValue(curLeft), asValue(value));
            }
          } else {
            expression = makeNode("expression", {op: comparator.image, args: [asValue(curLeft), asValue(value)], from: [curLeft, comparator, value]});
            self.block.expression(expression);
          }
          curLeft = value;
          if(expression) {
            expressions.push(expression);
          }
        }
        return makeNode("comparison", {expressions, from});
      };
      return left;
    });

    //-----------------------------------------------------------
    // Special Forms
    //-----------------------------------------------------------

    rule("notStatement", () => {
      let block = pushBlock();
      block.type = "not";
      let from: NodeDependent[] = [
        self.CONSUME(Not),
        self.CONSUME(OpenParen),
      ];
      self.MANY(() => {
        from.push(self.SUBRULE(self.statement) as ParseNode);
      });
      from.push(self.CONSUME(CloseParen));
      popBlock();
      block.from = from;
      self.block.scan(block);
      return;
    });

    rule("isExpression", () => {
      let op = self.CONSUME(Is);
      let from: NodeDependent[] = [
        op,
        self.CONSUME(OpenParen)
      ]
      let expressions = [];
      self.MANY(() => {
        let comparison: any = self.SUBRULE(self.comparison, [true]);
        for(let expression of comparison.expressions) {
          from.push(expression as ParseNode);
          expressions.push(asValue(expression));
        }
      });
      from.push(self.CONSUME(CloseParen));
      let variable = self.block.toVariable(`is|${op.startLine}|${op.startColumn}`, true);
      let is = makeNode("expression", {variable, op: "and", args: expressions, from});
      variable.from.push(is);
      self.block.expression(is);
      return is;
    });

    //-----------------------------------------------------------
    // If ... then
    //-----------------------------------------------------------

    rule("ifExpression", () => {
      let branches = [];
      let from = branches;
      branches.push(self.SUBRULE(self.ifBranch));
      self.MANY(() => {
        branches.push(self.OR([
          {ALT: () => { return self.SUBRULE2(self.ifBranch); }},
          {ALT: () => { return self.SUBRULE(self.elseIfBranch); }},
        ]));
      });
      self.OPTION(() => {
        branches.push(self.SUBRULE(self.elseBranch));
      });
      return makeNode("ifExpression", {branches, from});
    });

    rule("ifBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [
        self.CONSUME(If)
      ]
      self.AT_LEAST_ONE(() => {
        let statement = self.SUBRULE(self.statement) as ParseNode;
        if(statement) {
          from.push(statement);
        }
      })
      from.push(self.CONSUME(Then));
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: false, from});
    });

    rule("elseIfBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [
        self.CONSUME(Else),
        self.CONSUME(If),
      ]
      self.AT_LEAST_ONE(() => {
        from.push(self.SUBRULE(self.statement) as ParseNode);
      })
      from.push(self.CONSUME(Then));
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: true, from});
    });

    rule("elseBranch", () => {
      let block = pushBlock();
      let from: NodeDependent[] = [self.CONSUME(Else)];
      let expression = self.SUBRULE(self.expression) as ParseNode;
      from.push(expression);
      popBlock();
      return makeNode("ifBranch", {block, outputs: ifOutputs(expression), exclusive: true, from});
    });

    //-----------------------------------------------------------
    // Infix and operator precedence
    //-----------------------------------------------------------

    rule("infix", () => {
      return self.SUBRULE(self.addition);
    });

    rule("addition", () : any => {
      let left = self.SUBRULE(self.multiplication);
      let from = [left];
      let ops = [];
      self.MANY(function() {
        let op = self.CONSUME(AddInfix);
        let right = self.SUBRULE2(self.multiplication);
        from.push(op, right);
        ops.push({op, right})
      });
      if(!ops.length) {
        return left;
      } else {
        let expressions = [];
        let curVar;
        let curLeft = left;
        for(let pair of ops) {
          let {op, right} = pair;
          curVar = self.block.toVariable(`addition|${op.startLine}|${op.startColumn}`, true);
          let expression = makeNode("expression", {op: op.image, args: [asValue(curLeft), asValue(right)], variable: curVar, from: [curLeft, op, right]});
          expressions.push(expression);
          curVar.from.push(expression);
          self.block.expression(expression)
          curLeft = expression;
        }
        return makeNode("addition", {expressions, variable: curVar, from});
      }
    });

    rule("multiplication", () : any => {
      let left = self.SUBRULE(self.infixValue);
      let from = [left];
      let ops = [];
      self.MANY(function() {
        let op = self.CONSUME(MultInfix);
        let right = self.SUBRULE2(self.infixValue);
        from.push(op, right);
        ops.push({op, right})
      });
      if(!ops.length) {
        return left;
      } else {
        let expressions = [];
        let curVar;
        let curLeft = left;
        for(let pair of ops) {
          let {op, right} = pair;
          curVar = self.block.toVariable(`addition|${op.startLine}|${op.startColumn}`, true);
          let expression = makeNode("expression", {op: op.image, args: [asValue(curLeft), asValue(right)], variable: curVar, from: [curLeft, op, right]});
          expressions.push(expression);
          curVar.from.push(expression);
          self.block.expression(expression)
          curLeft = expression;
        }
        return makeNode("multiplication", {expressions, variable: curVar, from});
      }
    });

    rule("parenthesis", () => {
      let items = [];
      let from = [];
      from.push(self.CONSUME(OpenParen));
      self.AT_LEAST_ONE(() => {
        let item = self.SUBRULE(self.expression);
        items.push(asValue(item));
        from.push(item);
      })
      from.push(self.CONSUME(CloseParen));
      if(items.length === 1) {
        return items[0];
      }
      return makeNode("parenthesis", {items, from});
    });

    rule("infixValue", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.attributeAccess); }},
        {ALT: () => { return self.SUBRULE(self.functionRecord); }},
        {ALT: () => { return self.SUBRULE(self.isExpression); }},
        {ALT: () => { return self.SUBRULE(self.variable); }},
        {ALT: () => { return self.SUBRULE(self.value); }},
        {ALT: () => { return self.SUBRULE(self.parenthesis); }},
      ]);
    })

    //-----------------------------------------------------------
    // Expression
    //-----------------------------------------------------------

    rule("expression", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.infix); }},
        {ALT: () => { return self.SUBRULE(self.record); }},
      ]);
    });

    //-----------------------------------------------------------
    // Variable
    //-----------------------------------------------------------

    rule("variable", (forceGenerate = false) => {
      let token = self.CONSUME(Identifier);
      let name = token.image;
      if(forceGenerate) {
        name = `${token.image}-${token.startLine}-${token.startColumn}`;
      }
      let variable = self.block.toVariable(name, forceGenerate);
      variable.from.push(token);
      return variable;
    });

    //-----------------------------------------------------------
    // Values
    //-----------------------------------------------------------

    rule("stringInterpolation", () : any => {
      let args = [];
      let start = self.CONSUME(StringOpen);
      let from: NodeDependent[] = [start];
      self.MANY(() => {
        let arg = self.OR([
          {ALT: () => {
            let str = self.CONSUME(StringChars);
            return makeNode("constant", {value: cleanString(str.image), from: [str]});
          }},
          {ALT: () => {
            self.CONSUME(StringEmbedOpen);
            let expression = self.SUBRULE(self.infix);
            self.CONSUME(StringEmbedClose);
            return expression;
          }},
        ]);
        args.push(asValue(arg));
        from.push(arg as ParseNode);
      });
      from.push(self.CONSUME(StringClose));
      if(args.length === 1 && args[0].type === "constant") {
        return args[0];
      }
      let variable = self.block.toVariable(`concat|${start.startLine}|${start.startColumn}`, true);
      let expression = makeNode("expression", {op: "concat", args, variable, from});
      variable.from.push(expression);
      self.block.expression(expression);
      return expression;
    });

    rule("value", () => {
      return self.OR([
        {ALT: () => { return self.SUBRULE(self.stringInterpolation) }},
        {ALT: () => { return self.SUBRULE(self.num) }},
        {ALT: () => { return self.SUBRULE(self.bool) }},
      ])
    })

    rule("bool", () => {
      let value = self.CONSUME(Bool);
      return makeNode("constant", {value: value.image === "true", from: [value]});
    })

    rule("num", () => {
      let num = self.CONSUME(Num);
      return makeNode("constant", {value: parseFloat(num.image), from: [num]}) ;
    });

    //-----------------------------------------------------------
    // Chevrotain analysis
    //-----------------------------------------------------------

    Parser.performSelfAnalysis(this);
  }
}

//-----------------------------------------------------------
// Public API
//-----------------------------------------------------------

let eveParser = new Parser([]);

export function parseBlock(block, blockId, offset = 0, spans = []) {
  let start = time();
  let lex = EveBlockLexer.tokenize(block);
  let token: any;
  let tokenIx = 0;
  for(token of lex.tokens) {
    let tokenId = `${blockId}|${tokenIx++}`;
    token.id = tokenId;
    spans.push(offset + token.startOffset, offset + token.startOffset + token.image.length, token.label, tokenId);
  }
  eveParser.input = lex.tokens;
  // The parameters here are a strange quirk of how Chevrotain works, I believe the
  // 1 tells chevrotain what level the rule is starting at, we then pass our params
  // to the codeBlock parser function as an array
  let results = eveParser.codeBlock(1, [blockId]);
  return {
    results,
    lex,
    time: time(start),
    errors: eveParser.errors,
  }
}

let docIx = 0;
export function parseDoc(doc, docId = `doc|${docIx++}`) {
  let start = time();
  let {text, spans, blocks, extraInfo} = parseMarkdown(doc, docId);
  let parsedBlocks = [];
  for(let block of blocks) {
    let {results, lex, errors} = parseBlock(block.literal, block.id, block.startOffset, spans);
    parsedBlocks.push(results);
  }
  return {
    results: {blocks: parsedBlocks, text, spans, extraInfo},
    time: time(start),
    errors: eveParser.errors,
  }
}
