var _ = require("lodash")
var t = require("babel-types")
var babylon = require("babylon")
var Vinyl = require('vinyl')
var traverse = require("babel-traverse").default
var generator = require("babel-generator").default
var {
    NodeJsInputFileSystem,
    CachedInputFileSystem,
    ResolverFactory
} = require("enhanced-resolve");

var path = require("path")
var fs = require("fs-extra")

function Deps(options) {
    this.depends = []
    this.pulledList = []
    this.map = {}
    this.config = this.ensureConfig(options)
    this.resolver = ResolverFactory.createResolver(_.extend({
        fileSystem: new CachedInputFileSystem(new NodeJsInputFileSystem(), 4000),
        useSyncFileSystemCalls: true,
    }, options.resolve))

    this.cache = {}
    if( options.cache ) {
        try{
            this.cache = JSON.parse(fs.readFileSync(options.cache, "utf-8"))
        }catch(e) {
            this.cache = {}
        }
    }
    this.findDeps({
        path: unix(options.entry),
        file: options.file
    })
}

Deps.prototype.ensureConfig = function(config) {
    if( !path.isAbsolute( config.output) ) {
        config.output = path.resolve(config.base, config.output)
    }
    config.resolve = this.ensureResolve(config)
    return config
}

Deps.prototype.ensureResolve = function(config) {
    const resolve = config.resolve
    const oldAlias = resolve.alias
    const alias = {}
    const self = this
    _.each(oldAlias, function(val, key) {
        if( path.isAbsolute(val) || self.isModule(val)) {
            alias[key] = val
        }else {
            alias[key] = path.resolve(config.base, val)
        }
    })
    return _.extend({}, resolve, {
        alias: alias
    })
}

const REGEXP_NOT_MODULE = /^\.$|^\.[\\\/]|^\.\.$|^\.\.[\/\\]|^\/|^[A-Z]:[\\\/]/i;
Deps.prototype.isModule = function(path) {
    return !REGEXP_NOT_MODULE.test(path)
}

Deps.prototype.addExtname = function(dep) {
    var extensions = _.get(this.config, "resolve.extensions")
    var pth = dep
    for(var i = 0, len = extensions.length; i < len - 1; i++ ) {
        if( dep.indexOf(extensions[i]) > -1 ) {
            break
        }
        try {
            if( !fs.accessSync(dep + extensions[i]) ) {
                pth = dep + extensions[i]
                break
            }
        }catch(e) {
            console.log(e)
        }
    }
    return pth
}

Deps.prototype.transferExtname = function(src, dist) {
    var extname = path.extname(src)
    if( dist.indexOf(extname) > -1 ) {
        return dist
    }
    return dist + extname
}

Deps.prototype.transferAlias = function(dep, origin) {
    var alias = _.get(this.config, "resolve.alias")
    var newDep = dep
    var transfer = _.find(alias, function(val, key) {
        if( /\$$/.test(key) && dep === key.substr(0, key.length - 1)) {
            newDep = unix(val)
            return true
        }
        if( !/\$$/.test(key) && dep.indexOf(key) === 0 ) {
            newDep = unix(val) + dep.substr(key.length, dep.length - key.length)
            return true
        }
    })
    return {
        dep: newDep,
        transfer: !!transfer
    }
}

Deps.prototype.findDeps = function(opts, isModule) {
    var origin = opts.path
    if(  _.indexOf(this.pulledList, origin) > -1 ) { // 解析过，忽略
        return
    }else {
        this.pulledList.push(origin)
    }
    
    var code, isVinyl
    try {
        if( opts.file && Vinyl.isVinyl(opts.file) && !opts.file.isNull() ) {
            code = opts.file.contents.toString()
            isVinyl = true
        }else {
            code = fs.readFileSync(opts.path, 'utf-8')
        }
    }catch(e) {
        console.error(e)
        return
    }
    var ast
    try{
        ast = babylon.parse(code, {
            sourceType: "module"
        })
    }catch(e) {
        console.log("Parse Error in ", origin, "\n", e)
        return
    }
    var self = this
    traverse(ast, {
        enter: function(path) {
            if ( t.isImportDeclaration(path) ) {
                self.pushDeps(
                    path.node.source.value, 
                    origin,
                    isModule,
                    isVinyl
                )
            }else if ( t.isCallExpression(path) && 
                t.isIdentifier(path.node.callee) && 
                path.node.callee.name === 'require' &&
                path.node.arguments.length === 1 &&
                t.isStringLiteral(path.node.arguments[0])
            ) {
                self.pushDeps(
                    path.node.arguments[0].value, 
                    origin,
                    isModule,
                    isVinyl
                )
            }
        }
    })
}

Deps.prototype.pushDeps = function(dep, origin, isModule, isVinyl) {
    var config = this.config
    var src 
    try {
        src = this.resolver.resolveSync(
            {}, path.dirname(origin), dep
        )
    }catch(e) {
        throw new Error("Can't resolve '" + dep + "' in " + origin)
        return
    }
    src = unix(this.addExtname(src))
    var transferInfo = this.transferAlias(dep, origin)
    var _isModule = this.isModule(transferInfo.dep)
    var _isModuleExtend = !!(_isModule || isModule)
    var depObj = {
        key: dep, // 源文件的引用
        src: src, // 源文件的引用的绝对路径
        dep: transferInfo.dep, // 源文件的alias转换过后的引用
        origin: unix(origin), // 源文件的绝对路径
        transfer: transferInfo.transfer, // 是否成功匹配alias规则
        module: _isModuleExtend, // 源文件的引用是否为模块（继承源文件）
        _module: _isModule, // 源文件的引用是否为模块
        vinyl: isVinyl
    }
    
    let inCache = this.checkInCache(src)
    if( inCache ) {
        this.saveFromCache(depObj, inCache)
        return
    }
    this.depends.push(depObj)
    this.findDeps({
        path: src
    }, _isModuleExtend)
}

Deps.prototype.getDeps = function() {
    return this.depends
}

Deps.prototype.parseDeps = function() {
    var that = this
    var base = this.config.base
    this.depends.forEach(function(item) {
        if( !item.transfer && !item.module ) { // 没有用alias，不是外部模块, 直接忽略了
            return 
        }
        if( item.transfer && !item.module ) { // 用了alias,不是外部模块
            that.saveAlias(item)
            return
        }
        
        that.save(item)
    })
}

Deps.prototype.checkInCache = function(pth) {
    return this.cache && this.cache[pth]
}

Deps.prototype.updateDeps = function(oldOrigin, newOrigin) {
    this.depends = this.depends.map(function(dep) {
        if( dep.origin === oldOrigin ) {
            dep.origin = newOrigin
        }
        return dep
    })
}

Deps.prototype.save = function(depObj) {
    var config = this.config
    var currentDir = path.dirname(depObj.origin)
    var src = depObj.src
    var dist
    if( depObj._module ) {
        dist = this.resolve(config.output, depObj.dep)
    }else {
        dist = this.resolve(
            config.output, 
            this.resolve(
                path.dirname(depObj.origin), depObj.dep
            )
        )
    }
    dist = this.transferExtname(src, dist)
    this.updateDeps(src, dist)
    try {
        fs.copySync(src, dist)
    }catch(e) {
        console.error(e)
    }
    this.cache[src] = dist
    this.collectMap(        
        depObj, 
        unix(path.relative(currentDir, dist))
    )
}

Deps.prototype.saveFromCache = function(depObj, dist) {
    var currentDir = path.dirname(depObj.origin)
    this.collectMap(
        depObj, 
        unix(path.relative(currentDir, dist))
    )
}

Deps.prototype.saveAlias = function(depObj) {
    var dep = path.relative(path.dirname(depObj.origin), depObj.src)
    this.collectMap(
        depObj,
        unix(dep)
    )
}

Deps.prototype.collectMap = function(depObj, val) {
    var origin = depObj.origin
    var key = depObj.key
    var map = this.map
    if( !map[origin] ) {
        map[origin] = {}
    }
    if( this.isModule(val) ) {
        val = "./" + val
    }
    map[origin][key] = val
    if( depObj.module && !depObj.vinyl ) {
        this.transfrom(origin, true)
    }
}

Deps.prototype.outputMap = function() {
    this.saveCache()
    return this.map
}

Deps.prototype.saveCache = function() {
    if( !this.cache ) {
        return
    }
    try {
        fs.writeFileSync(this.config.cache, JSON.stringify(this.cache, null, 4))
    }catch(e) {}
}

Deps.prototype.transfrom = function(pth, sync) {
    pth = unix(pth)
    var code = fs.readFileSync(pth, 'utf-8')
    var ast = babylon.parse(code, {
        sourceType: "module"
    })
    var mapping = this.map[pth] || {}
    this.saveCache()
    traverse(ast, {
        enter: function(path) {
            if ( t.isImportDeclaration(path) && 
                mapping[path.node.source.value]
            ) {
                path.node.source.value = mapping[path.node.source.value]
            }else if ( t.isCallExpression(path) && 
                t.isIdentifier(path.node.callee) && 
                path.node.callee.name === 'require' &&
                path.node.arguments.length === 1 &&
                mapping[path.node.arguments[0].value]
            ) {
                path.node.arguments[0].value = mapping[path.node.arguments[0].value]
            }
        }
    })
    var gen = generator(ast).code
    if( sync ) {
        try {
            fs.outputFileSync(pth, gen)
        }catch(e) {
            console.log(e)
        }
    }
    return gen
}

Deps.prototype.resolve = function(base, part) {
    return unix(path.resolve(base, part))
}

// 解决windows系统下路径的反斜杠问题
function unix(url) {
    return url.replace(/\\/g, "/")
}

module.exports = Deps
module.exports.unix = unix
module.exports.resolve = Deps.prototype.resolve