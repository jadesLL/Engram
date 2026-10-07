package com.engram.app

import org.junit.Assert.*
import org.junit.Test

class PairingInviteTest {
    @Test fun validLink() {
        val invite = PairingInvite.parse("配对：engram://join?hub=http%3A%2F%2F192.168.1.20%3A18080&token=lsync_abcdef&v=1")!!
        assertEquals("http://192.168.1.20:18080", invite.hubUrl)
        assertEquals("lsync_abcdef", invite.token)
    }
    @Test fun invalidLinks() {
        for (hub in listOf("file%3A%2F%2F%2Ftmp", "ftp%3A%2F%2Fhub", "http%3A%2F%2Fu%3Ap%40hub")) {
            assertNull(PairingInvite.parse("engram://join?hub=$hub&token=lsync_abcdef"))
        }
        assertNull(PairingInvite.parse("engram://join?hub=http%3A%2F%2Fhub&token=x"))
        assertNull(PairingInvite.parse("普通文字"))
    }
}
