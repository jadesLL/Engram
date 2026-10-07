package com.engram.app

import org.json.JSONObject
import java.util.UUID

/** 与 server/sync/categories.ts 和 preferences.ts 使用相同字段和缺省值。 */
class SyncPreferences(private val db: LocalDatabase) {
    private fun nodeId(): String = db.setting("sync_node_id")?.takeIf { it.isNotBlank() }
        ?: UUID.randomUUID().toString().also { db.setSetting("sync_node_id", it) }
    companion object {
        val defaults = linkedMapOf("knowledge" to true, "materials" to true, "assets" to true,
            "aiWorkspace" to true, "sessions" to true, "board" to true, "homeCards" to false, "settings" to false)
        val keys = listOf("home_layout", "search_synonyms", "name_fixes", "show_ai_workspace", "theme", "editor_mode")
    }
    fun categories(): JSONObject {
        val saved = runCatching { JSONObject(db.setting("sync_categories") ?: "{}") }.getOrDefault(JSONObject())
        return JSONObject().also { out -> defaults.forEach { (key, value) ->
            out.put(key, if (saved.opt(key) is Boolean) saved.getBoolean(key) else value)
        } }
    }
    fun saveCategories(input: JSONObject) {
        val next = categories()
        input.keys().forEach { key ->
            require(key in defaults && input.opt(key) is Boolean) { "同步分类开关无效" }
            next.put(key, input.getBoolean(key))
        }
        db.setSetting("sync_categories", next.toString())
    }
    private fun category(kind: String, target: String): String? = when (kind) {
        "preference" -> if (target == "home_layout") "homeCards" else if (target in keys) "settings" else null
        "session" -> "sessions"
        "board" -> "board"
        "page", "file", "move", "delete" -> when (target.replace('\\', '/').substringBefore('/')) {
            "原始资料" -> "materials"
            "AIWorks" -> "aiWorkspace"
            "assets" -> "assets"
            else -> "knowledge"
        }
        else -> null
    }
    fun allowed(kind: String, target: String, oldPath: String = ""): Boolean {
        val flags = categories()
        return flags.optBoolean(category(kind, target) ?: return false) &&
            (oldPath.isBlank() || flags.optBoolean(category(kind, oldPath) ?: return false))
    }
    fun value(key: String): JSONObject? {
        if (key !in keys) return null
        val value = db.setting(key) ?: return null
        val meta = runCatching { JSONObject(db.setting("sync_preference:$key") ?: "{}") }.getOrDefault(JSONObject())
        return JSONObject().put("value", value).put("updatedAt", meta.optLong("updatedAt")).put("nodeId", meta.optString("nodeId").ifBlank { nodeId() })
    }
    fun stamp(key: String) {
        if (key !in keys) return
        val updatedAt = maxOf(System.currentTimeMillis(), (value(key)?.optLong("updatedAt") ?: 0L) + 1L)
        db.setSetting("sync_preference:$key", JSONObject().put("updatedAt", updatedAt).put("nodeId", nodeId()).toString())
    }
    fun wins(a: JSONObject, b: JSONObject?): Boolean = b == null ||
        a.optLong("updatedAt") > b.optLong("updatedAt") ||
        (a.optLong("updatedAt") == b.optLong("updatedAt") && a.optString("nodeId") > b.optString("nodeId"))
    fun merge(key: String, p: JSONObject?): Boolean {
        if (!allowed("preference", key) || p == null || p.opt("value") !is String ||
            p.optString("value").length > 1000000 || p.optLong("updatedAt", -1) < 0 || p.opt("nodeId") !is String || !wins(p, value(key))) return false
        db.setSetting(key, p.getString("value"))
        db.setSetting("sync_preference:$key", JSONObject().put("updatedAt", p.getLong("updatedAt")).put("nodeId", p.getString("nodeId")).toString())
        db.bumpContentRevision()
        return true
    }
}
