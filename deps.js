var _ = require("lodash");
var t = require("babel-types")
var babylon = require("babylon")
var traverse = require("babel-traverse").default
var generator = require("babel-generator").default

var path = require("path")
var fs = require("fs-extra")

var defaultConfig = {
    entry: "index.js",
    src: {
        npm: "/"
    },
    dist: {
        npm: "/"
    },
    ignoreRelative: true // 忽略相对路径的依赖
}

var BASE_DIR = process.cwd()
var pkgJson = fs.readJsonSync(path.resolve(BASE_DIR, "./package.json"))
var dependencies = _.get(pkgJson, "dependencies")
var devpendencies = _.get(pkgJson, "devpendencies")

function Deps(options) {
    this.depends = []
    this.pulledList = []
    this.map = {}
    this.config = this.processConfig(options || {})
    this.findDeps(this.config.entry)
}

Deps.prototype.processConfig = function(config) {
    var obj = {};
    _.each(
        ["entry", "src.npm", "src.custom", "dist.npm", "dist.custom", "dist.root"],
        function(key) {
            var val = _.get(config, key)
            if( val && !path.isAbsolute(val) ) {
                _.set(obj, key, unix(path.resolve(BASE_DIR, val)))
            }else if( val ) {
                _.set(obj, key, unix(val))
            }
        }
    )
    return _.extend({}, defaultConfig, config, obj)
}

Deps.prototype.isAbsolute = function(path) {
    // 不是 ./ 或者 ../ 开头的路径
    return !/^\.{1,2}\//.test(path)
}

Deps.prototype.findDeps = function(origin, dist) {
    if( !/\.js$/.test(origin) ) {
        origin = origin + ".js"
    }
    if( dist && !/\.js$/.test(dist) ) {
        dist = dist + ".js"
    }
    var code
    try {
        code = fs.readFileSync(origin, 'utf-8')
    }catch(e) {
        console.error(e)
        return
    }
    var ast = babylon.parse(code, {
        sourceType: "module"
    })
    var self = this
    traverse(ast, {
        enter: function(path) {
            if ( t.isImportDeclaration(path) ) {
                self.pushDeps(
                    path.node.source.value, 
                    origin
                )
            }else if ( t.isCallExpression(path) && 
                t.isIdentifier(path.node.callee) && 
                path.node.callee.name === 'require' &&
                path.node.arguments.length === 1
            ) {
                self.pushDeps(
                    path.node.arguments[0].value, 
                    origin
                )
            }
        }
    })
    if( dist ) {
        fs.copySync(origin, dist)
    }
}

Deps.prototype.pushDeps = function(dep, origin) {
    var config = this.config
    var relativeDep, relativeDepDist
    if( this.isAbsolute(dep) ) {
        return this.depends.push({
            dep: dep,
            originDep: dep,
            origin: origin
        })
    }
    dep = dep.replace(/^\.\//, "../") // ./index.js => ../index.js
    relativeDep = path.resolve(origin, dep)
    if( !config.ignoreRelative && config.dist.root ) {
        this.findDeps(relativeDep, path.resolve(config.dist.root, dep))
    }else {
        this.findDeps(relativeDep)
    }
}

Deps.prototype.getDeps = function() {
    return this.depends
}

Deps.prototype.parseDeps = function() {
    var config = this.config
    var self = this
    this.depends.forEach(function(item) {
        var dep = item.dep
        if( _.has(dependencies, dep) || _.has(devpendencies, dep) ) {
            return self.pullNpmDep(item)
        }
        if( !/\.js$/.test(dep) ) {
            item.dep = dep + ".js"
        }
        if( config.src.custom && fs.existsSync(path.resolve(config.src.custom, item.dep)) ) {
            return self.pullCustomDep(item)
        }
    })
}

Deps.prototype.pullCustomDep = function(depObj) {
    var dep = depObj.dep
    var config = this.config
    var entry = unix(path.resolve(config.src.custom, dep))
    var paths = entry.split("/")
    var nextDep = new Deps({
        entry: entry,
        src: _.extend({}, config.src),
        dist: _.extend({}, config.dist, {
            root: path.resolve(config.dist.custom, dep)
        }),
        ignoreRelative: false
    })
    nextDep.parseDeps()
    return this.saveCustomDep(entry, depObj)
}

Deps.prototype.pullNpmDep = function(depObj) {
    var dep = depObj.dep
    var config = this.config
    var pkgDir = path.resolve(config.src.npm, dep)
    var pkgJson = fs.readJsonSync(path.resolve(pkgDir, "./package.json"))

    if( _.get(pkgJson, "main").indexOf(dep) > -1 ){
        return this.saveNpmDep(pkgDir, depObj, _.get(pkgJson, "main"))   
    }
    if( fs.existsSync(path.resolve(config.src.npm, dep, "./index.js")) ) {
        return this.saveNpmDep(pkgDir, depObj, "./index.js")    
    }
}

Deps.prototype.saveNpmDep = function(pkgDir, depObj, filename) {
    var config = this.config;
    var dep = depObj.dep
    var distDir = path.resolve(config.dist.npm, dep)
    var dist = path.resolve(distDir, filename)
    var currentDir = path.resolve(depObj.origin, "../")
    try {
        fs.copySync(pkgDir, distDir)
        this.collectMap(
            unix(depObj.origin), 
            depObj.originDep, 
            unix(path.relative(currentDir, dist))
        )
    }catch(e) {
        console.error(e)
    }
}

Deps.prototype.saveCustomDep = function(src, depObj) {
    var config = this.config
    var dep = depObj.dep
    var dist = path.resolve(config.dist.custom, dep)
    var currentDir = path.resolve(depObj.origin, "../")
    try {
        fs.copySync(src, dist)
        this.collectMap(        
            unix(depObj.origin), 
            depObj.originDep, 
            unix(path.relative(currentDir, dist))
        )
    }catch(e) {
        console.error(e)
    }
}

Deps.prototype.collectMap = function(origin, key, val) {
    var map = this.map
    if( !map[origin] ) {
        map[origin] = {}
    }
    map[origin][key] = val
}

Deps.prototype.outputMap = function(dist) {
    return this.map
}

Deps.prototype.transfrom = function(pth) {
    pth = unix(pth)
    var code = fs.readFileSync(pth, 'utf-8')
    var ast = babylon.parse(code, {
        sourceType: "module"
    })
    var mapping = this.map[pth] || {}
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
    return generator(ast).code
}

// 解决windows系统下路径的反斜杠问题
function unix(url) {
    return url.replace(/\\/g, "/");
}

module.exports = Deps
module.exports.unix = unix