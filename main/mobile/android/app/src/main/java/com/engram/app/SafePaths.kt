package com.engram.app

import java.io.File

object SafePaths {
    fun resolve(base: File, relative: String): File {
        val clean = relative.replace('\\', '/').trimStart('/')
        require(clean.isNotEmpty() && clean.split('/').none { it == ".." || it.isEmpty() }) { "路径无效" }
        val root = base.canonicalFile
        val target = File(root, clean).canonicalFile
        require(target.path.startsWith(root.path + File.separator)) { "路径无效" }
        return target
    }
}
