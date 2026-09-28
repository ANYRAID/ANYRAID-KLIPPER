00001cf0 <digital_load_event>:
    1cf0:	8f 92       	push	r8
    1cf2:	9f 92       	push	r9
    1cf4:	af 92       	push	r10
    1cf6:	bf 92       	push	r11
    1cf8:	cf 92       	push	r12
    1cfa:	df 92       	push	r13
    1cfc:	ef 92       	push	r14
    1cfe:	ff 92       	push	r15
    1d00:	1f 93       	push	r17
    1d02:	cf 93       	push	r28
    1d04:	df 93       	push	r29
    1d06:	ec 01       	movw	r28, r24
    1d08:	ef 8c       	ldd	r14, Y+31	; 0x1f
    1d0a:	f8 a0       	ldd	r15, Y+32	; 0x20
    1d0c:	e1 14       	cp	r14, r1
    1d0e:	f1 04       	cpc	r15, r1
    1d10:	09 f4       	brne	.+2      	; 0x1d14 <digital_load_event+0x24>
    1d12:	00 c1       	rjmp	.+512    	; 0x1f14 <digital_load_event+0x224>
    1d14:	f7 01       	movw	r30, r14
    1d16:	80 81       	ld	r24, Z
    1d18:	91 81       	ldd	r25, Z+1	; 0x01
    1d1a:	98 a3       	std	Y+32, r25	; 0x20
    1d1c:	8f 8f       	std	Y+31, r24	; 0x1f
    1d1e:	86 80       	ldd	r8, Z+6	; 0x06
    1d20:	97 80       	ldd	r9, Z+7	; 0x07
    1d22:	a0 84       	ldd	r10, Z+8	; 0x08
    1d24:	b1 84       	ldd	r11, Z+9	; 0x09
    1d26:	11 e0       	ldi	r17, 0x01	; 1
    1d28:	81 14       	cp	r8, r1
    1d2a:	91 04       	cpc	r9, r1
    1d2c:	a1 04       	cpc	r10, r1
    1d2e:	b1 04       	cpc	r11, r1
    1d30:	09 f4       	brne	.+2      	; 0x1d34 <digital_load_event+0x44>
    1d32:	b6 c0       	rjmp	.+364    	; 0x1ea0 <digital_load_event+0x1b0>
    1d34:	6c 89       	ldd	r22, Y+20	; 0x14
    1d36:	7d 89       	ldd	r23, Y+21	; 0x15
    1d38:	8e 89       	ldd	r24, Y+22	; 0x16
    1d3a:	41 2f       	mov	r20, r17
    1d3c:	0e 94 a3 4d 	call	0x9b46	; 0x9b46 <gpio_out_write.lto_priv.79>
    1d40:	80 91 6d 01 	lds	r24, 0x016D	; 0x80016d <move_free_list.lto_priv.88>
    1d44:	90 91 6e 01 	lds	r25, 0x016E	; 0x80016e <move_free_list.lto_priv.88+0x1>
    1d48:	f7 01       	movw	r30, r14
    1d4a:	91 83       	std	Z+1, r25	; 0x01
    1d4c:	80 83       	st	Z, r24
    1d4e:	f0 92 6e 01 	sts	0x016E, r15	; 0x80016e <move_free_list.lto_priv.88+0x1>
    1d52:	e0 92 6d 01 	sts	0x016D, r14	; 0x80016d <move_free_list.lto_priv.88>
    1d56:	81 14       	cp	r8, r1
    1d58:	91 04       	cpc	r9, r1
    1d5a:	a1 04       	cpc	r10, r1
    1d5c:	b1 04       	cpc	r11, r1
    1d5e:	89 f1       	breq	.+98     	; 0x1dc2 <digital_load_event+0xd2>
    1d60:	8b 8d       	ldd	r24, Y+27	; 0x1b
    1d62:	9c 8d       	ldd	r25, Y+28	; 0x1c
    1d64:	ad 8d       	ldd	r26, Y+29	; 0x1d
    1d66:	be 8d       	ldd	r27, Y+30	; 0x1e
    1d68:	88 16       	cp	r8, r24
    1d6a:	99 06       	cpc	r9, r25
    1d6c:	aa 06       	cpc	r10, r26
    1d6e:	bb 06       	cpc	r11, r27
    1d70:	40 f5       	brcc	.+80     	; 0x1dc2 <digital_load_event+0xd2>
    1d72:	4f 89       	ldd	r20, Y+23	; 0x17
    1d74:	58 8d       	ldd	r21, Y+24	; 0x18
    1d76:	69 8d       	ldd	r22, Y+25	; 0x19
    1d78:	7a 8d       	ldd	r23, Y+26	; 0x1a
    1d7a:	41 15       	cp	r20, r1
    1d7c:	51 05       	cpc	r21, r1
    1d7e:	61 05       	cpc	r22, r1
    1d80:	71 05       	cpc	r23, r1
    1d82:	09 f4       	brne	.+2      	; 0x1d86 <digital_load_event+0x96>
    1d84:	bb c0       	rjmp	.+374    	; 0x1efc <digital_load_event+0x20c>
    1d86:	8c 81       	ldd	r24, Y+4	; 0x04
    1d88:	9d 81       	ldd	r25, Y+5	; 0x05
    1d8a:	ae 81       	ldd	r26, Y+6	; 0x06
    1d8c:	bf 81       	ldd	r27, Y+7	; 0x07
    1d8e:	48 0f       	add	r20, r24
    1d90:	59 1f       	adc	r21, r25
    1d92:	6a 1f       	adc	r22, r26
    1d94:	7b 1f       	adc	r23, r27
    1d96:	16 60       	ori	r17, 0x06	; 6
    1d98:	ef 8d       	ldd	r30, Y+31	; 0x1f
    1d9a:	f8 a1       	ldd	r31, Y+32	; 0x20
    1d9c:	30 97       	sbiw	r30, 0x00	; 0
    1d9e:	b9 f1       	breq	.+110    	; 0x1e0e <digital_load_event+0x11e>
    1da0:	c2 80       	ldd	r12, Z+2	; 0x02
    1da2:	d3 80       	ldd	r13, Z+3	; 0x03
    1da4:	e4 80       	ldd	r14, Z+4	; 0x04
    1da6:	f5 80       	ldd	r15, Z+5	; 0x05
    1da8:	87 2f       	mov	r24, r23
    1daa:	4c 15       	cp	r20, r12
    1dac:	5d 05       	cpc	r21, r13
    1dae:	6e 05       	cpc	r22, r14
    1db0:	8f 09       	sbc	r24, r15
    1db2:	87 fd       	sbrc	r24, 7
    1db4:	b2 c0       	rjmp	.+356    	; 0x1f1a <digital_load_event+0x22a>
    1db6:	8b a1       	ldd	r24, Y+35	; 0x23
    1db8:	91 2f       	mov	r25, r17
    1dba:	92 70       	andi	r25, 0x02	; 2
    1dbc:	b7 01       	movw	r22, r14
    1dbe:	a6 01       	movw	r20, r12
    1dc0:	7e c0       	rjmp	.+252    	; 0x1ebe <digital_load_event+0x1ce>
    1dc2:	8b a1       	ldd	r24, Y+35	; 0x23
    1dc4:	21 e0       	ldi	r18, 0x01	; 1
    1dc6:	81 14       	cp	r8, r1
    1dc8:	91 04       	cpc	r9, r1
    1dca:	a1 04       	cpc	r10, r1
    1dcc:	b1 04       	cpc	r11, r1
    1dce:	09 f0       	breq	.+2      	; 0x1dd2 <digital_load_event+0xe2>
    1dd0:	69 c0       	rjmp	.+210    	; 0x1ea4 <digital_load_event+0x1b4>
    1dd2:	84 fb       	bst	r24, 4
    1dd4:	99 27       	eor	r25, r25
    1dd6:	90 f9       	bld	r25, 0
    1dd8:	31 e0       	ldi	r19, 0x01	; 1
    1dda:	93 27       	eor	r25, r19
    1ddc:	29 17       	cp	r18, r25
    1dde:	09 f4       	brne	.+2      	; 0x1de2 <digital_load_event+0xf2>
    1de0:	42 c0       	rjmp	.+132    	; 0x1e66 <digital_load_event+0x176>
    1de2:	4f 89       	ldd	r20, Y+23	; 0x17
    1de4:	58 8d       	ldd	r21, Y+24	; 0x18
    1de6:	69 8d       	ldd	r22, Y+25	; 0x19
    1de8:	7a 8d       	ldd	r23, Y+26	; 0x1a
    1dea:	41 15       	cp	r20, r1
    1dec:	51 05       	cpc	r21, r1
    1dee:	61 05       	cpc	r22, r1
    1df0:	71 05       	cpc	r23, r1
    1df2:	c9 f1       	breq	.+114    	; 0x1e66 <digital_load_event+0x176>
    1df4:	8c 81       	ldd	r24, Y+4	; 0x04
    1df6:	9d 81       	ldd	r25, Y+5	; 0x05
    1df8:	ae 81       	ldd	r26, Y+6	; 0x06
    1dfa:	bf 81       	ldd	r27, Y+7	; 0x07
    1dfc:	48 0f       	add	r20, r24
    1dfe:	59 1f       	adc	r21, r25
    1e00:	6a 1f       	adc	r22, r26
    1e02:	7b 1f       	adc	r23, r27
    1e04:	14 60       	ori	r17, 0x04	; 4
    1e06:	ef 8d       	ldd	r30, Y+31	; 0x1f
    1e08:	f8 a1       	ldd	r31, Y+32	; 0x20
    1e0a:	30 97       	sbiw	r30, 0x00	; 0
    1e0c:	49 f6       	brne	.-110    	; 0x1da0 <digital_load_event+0xb0>
    1e0e:	2b a1       	ldd	r18, Y+35	; 0x23
    1e10:	48 8b       	std	Y+16, r20	; 0x10
    1e12:	59 8b       	std	Y+17, r21	; 0x11
    1e14:	6a 8b       	std	Y+18, r22	; 0x12
    1e16:	7b 8b       	std	Y+19, r23	; 0x13
    1e18:	20 71       	andi	r18, 0x10	; 16
    1e1a:	21 2b       	or	r18, r17
    1e1c:	2b a3       	std	Y+35, r18	; 0x23
    1e1e:	21 2f       	mov	r18, r17
    1e20:	24 70       	andi	r18, 0x04	; 4
    1e22:	11 ff       	sbrs	r17, 1
    1e24:	65 c0       	rjmp	.+202    	; 0x1ef0 <digital_load_event+0x200>
    1e26:	88 0d       	add	r24, r8
    1e28:	99 1d       	adc	r25, r9
    1e2a:	aa 1d       	adc	r26, r10
    1e2c:	bb 1d       	adc	r27, r11
    1e2e:	21 11       	cpse	r18, r1
    1e30:	58 c0       	rjmp	.+176    	; 0x1ee2 <digital_load_event+0x1f2>
    1e32:	2b ee       	ldi	r18, 0xEB	; 235
    1e34:	3a e0       	ldi	r19, 0x0A	; 10
    1e36:	3b 83       	std	Y+3, r19	; 0x03
    1e38:	2a 83       	std	Y+2, r18	; 0x02
    1e3a:	8c 83       	std	Y+4, r24	; 0x04
    1e3c:	9d 83       	std	Y+5, r25	; 0x05
    1e3e:	ae 83       	std	Y+6, r26	; 0x06
    1e40:	bf 83       	std	Y+7, r27	; 0x07
    1e42:	88 86       	std	Y+8, r8	; 0x08
    1e44:	99 86       	std	Y+9, r9	; 0x09
    1e46:	aa 86       	std	Y+10, r10	; 0x0a
    1e48:	bb 86       	std	Y+11, r11	; 0x0b
    1e4a:	8b 8d       	ldd	r24, Y+27	; 0x1b
    1e4c:	9c 8d       	ldd	r25, Y+28	; 0x1c
    1e4e:	ad 8d       	ldd	r26, Y+29	; 0x1d
    1e50:	be 8d       	ldd	r27, Y+30	; 0x1e
    1e52:	88 19       	sub	r24, r8
    1e54:	99 09       	sbc	r25, r9
    1e56:	aa 09       	sbc	r26, r10
    1e58:	bb 09       	sbc	r27, r11
    1e5a:	8c 87       	std	Y+12, r24	; 0x0c
    1e5c:	9d 87       	std	Y+13, r25	; 0x0d
    1e5e:	ae 87       	std	Y+14, r26	; 0x0e
    1e60:	bf 87       	std	Y+15, r27	; 0x0f
    1e62:	81 e0       	ldi	r24, 0x01	; 1
    1e64:	11 c0       	rjmp	.+34     	; 0x1e88 <digital_load_event+0x198>
    1e66:	90 e0       	ldi	r25, 0x00	; 0
    1e68:	ef 8d       	ldd	r30, Y+31	; 0x1f
    1e6a:	f8 a1       	ldd	r31, Y+32	; 0x20
    1e6c:	30 97       	sbiw	r30, 0x00	; 0
    1e6e:	19 f5       	brne	.+70     	; 0x1eb6 <digital_load_event+0x1c6>
    1e70:	18 8a       	std	Y+16, r1	; 0x10
    1e72:	19 8a       	std	Y+17, r1	; 0x11
    1e74:	1a 8a       	std	Y+18, r1	; 0x12
    1e76:	1b 8a       	std	Y+19, r1	; 0x13
    1e78:	80 71       	andi	r24, 0x10	; 16
    1e7a:	81 2b       	or	r24, r17
    1e7c:	8b a3       	std	Y+35, r24	; 0x23
    1e7e:	21 2f       	mov	r18, r17
    1e80:	24 70       	andi	r18, 0x04	; 4
    1e82:	80 e0       	ldi	r24, 0x00	; 0
    1e84:	91 11       	cpse	r25, r1
    1e86:	3e c0       	rjmp	.+124    	; 0x1f04 <digital_load_event+0x214>
    1e88:	df 91       	pop	r29
    1e8a:	cf 91       	pop	r28
    1e8c:	1f 91       	pop	r17
    1e8e:	ff 90       	pop	r15
    1e90:	ef 90       	pop	r14
    1e92:	df 90       	pop	r13
    1e94:	cf 90       	pop	r12
    1e96:	bf 90       	pop	r11
    1e98:	af 90       	pop	r10
    1e9a:	9f 90       	pop	r9
    1e9c:	8f 90       	pop	r8
    1e9e:	08 95       	ret
    1ea0:	10 e0       	ldi	r17, 0x00	; 0
    1ea2:	48 cf       	rjmp	.-368    	; 0x1d34 <digital_load_event+0x44>
    1ea4:	20 e0       	ldi	r18, 0x00	; 0
    1ea6:	84 fb       	bst	r24, 4
    1ea8:	99 27       	eor	r25, r25
    1eaa:	90 f9       	bld	r25, 0
    1eac:	31 e0       	ldi	r19, 0x01	; 1
    1eae:	93 27       	eor	r25, r19
    1eb0:	29 13       	cpse	r18, r25
    1eb2:	97 cf       	rjmp	.-210    	; 0x1de2 <digital_load_event+0xf2>
    1eb4:	d8 cf       	rjmp	.-80     	; 0x1e66 <digital_load_event+0x176>
    1eb6:	42 81       	ldd	r20, Z+2	; 0x02
    1eb8:	53 81       	ldd	r21, Z+3	; 0x03
    1eba:	64 81       	ldd	r22, Z+4	; 0x04
    1ebc:	75 81       	ldd	r23, Z+5	; 0x05
    1ebe:	48 8b       	std	Y+16, r20	; 0x10
    1ec0:	59 8b       	std	Y+17, r21	; 0x11
    1ec2:	6a 8b       	std	Y+18, r22	; 0x12
    1ec4:	7b 8b       	std	Y+19, r23	; 0x13
    1ec6:	80 71       	andi	r24, 0x10	; 16
    1ec8:	14 60       	ori	r17, 0x04	; 4
    1eca:	18 2b       	or	r17, r24
    1ecc:	1b a3       	std	Y+35, r17	; 0x23
    1ece:	99 23       	and	r25, r25
    1ed0:	79 f0       	breq	.+30     	; 0x1ef0 <digital_load_event+0x200>
    1ed2:	8c 81       	ldd	r24, Y+4	; 0x04
    1ed4:	9d 81       	ldd	r25, Y+5	; 0x05
    1ed6:	ae 81       	ldd	r26, Y+6	; 0x06
    1ed8:	bf 81       	ldd	r27, Y+7	; 0x07
    1eda:	88 0d       	add	r24, r8
    1edc:	99 1d       	adc	r25, r9
    1ede:	aa 1d       	adc	r26, r10
    1ee0:	bb 1d       	adc	r27, r11
    1ee2:	2b 2f       	mov	r18, r27
    1ee4:	84 17       	cp	r24, r20
    1ee6:	95 07       	cpc	r25, r21
    1ee8:	a6 07       	cpc	r26, r22
    1eea:	27 0b       	sbc	r18, r23
    1eec:	27 fd       	sbrc	r18, 7
    1eee:	a1 cf       	rjmp	.-190    	; 0x1e32 <digital_load_event+0x142>
    1ef0:	4c 83       	std	Y+4, r20	; 0x04
    1ef2:	5d 83       	std	Y+5, r21	; 0x05
    1ef4:	6e 83       	std	Y+6, r22	; 0x06
    1ef6:	7f 83       	std	Y+7, r23	; 0x07
    1ef8:	81 e0       	ldi	r24, 0x01	; 1
    1efa:	c6 cf       	rjmp	.-116    	; 0x1e88 <digital_load_event+0x198>
    1efc:	12 60       	ori	r17, 0x02	; 2
    1efe:	8b a1       	ldd	r24, Y+35	; 0x23
    1f00:	92 e0       	ldi	r25, 0x02	; 2
    1f02:	b2 cf       	rjmp	.-156    	; 0x1e68 <digital_load_event+0x178>
    1f04:	40 e0       	ldi	r20, 0x00	; 0
    1f06:	50 e0       	ldi	r21, 0x00	; 0
    1f08:	ba 01       	movw	r22, r20
    1f0a:	8c 81       	ldd	r24, Y+4	; 0x04
    1f0c:	9d 81       	ldd	r25, Y+5	; 0x05
    1f0e:	ae 81       	ldd	r26, Y+6	; 0x06
    1f10:	bf 81       	ldd	r27, Y+7	; 0x07
    1f12:	89 cf       	rjmp	.-238    	; 0x1e26 <digital_load_event+0x136>
    1f14:	85 e1       	ldi	r24, 0x15	; 21
    1f16:	0e 94 03 1c 	call	0x3806	; 0x3806 <sched_shutdown.lto_priv.13>
    1f1a:	83 e1       	ldi	r24, 0x13	; 19
    1f1c:	0e 94 03 1c 	call	0x3806	; 0x3806 <sched_shutdown.lto_priv.13>
