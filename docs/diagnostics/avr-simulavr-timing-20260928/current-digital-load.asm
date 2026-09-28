00001802 <digital_load_event.lto_priv.90>:
    1802:	8f 92       	push	r8
    1804:	9f 92       	push	r9
    1806:	af 92       	push	r10
    1808:	bf 92       	push	r11
    180a:	cf 92       	push	r12
    180c:	df 92       	push	r13
    180e:	ef 92       	push	r14
    1810:	ff 92       	push	r15
    1812:	1f 93       	push	r17
    1814:	cf 93       	push	r28
    1816:	df 93       	push	r29
    1818:	ec 01       	movw	r28, r24
    181a:	ab a0       	ldd	r10, Y+35	; 0x23
    181c:	bc a0       	ldd	r11, Y+36	; 0x24
    181e:	a1 14       	cp	r10, r1
    1820:	b1 04       	cpc	r11, r1
    1822:	09 f4       	brne	.+2      	; 0x1826 <digital_load_event.lto_priv.90+0x24>
    1824:	f8 c0       	rjmp	.+496    	; 0x1a16 <digital_load_event.lto_priv.90+0x214>
    1826:	f5 01       	movw	r30, r10
    1828:	80 81       	ld	r24, Z
    182a:	91 81       	ldd	r25, Z+1	; 0x01
    182c:	9c a3       	std	Y+36, r25	; 0x24
    182e:	8b a3       	std	Y+35, r24	; 0x23
    1830:	c6 80       	ldd	r12, Z+6	; 0x06
    1832:	d7 80       	ldd	r13, Z+7	; 0x07
    1834:	e0 84       	ldd	r14, Z+8	; 0x08
    1836:	f1 84       	ldd	r15, Z+9	; 0x09
    1838:	11 e0       	ldi	r17, 0x01	; 1
    183a:	c1 14       	cp	r12, r1
    183c:	d1 04       	cpc	r13, r1
    183e:	e1 04       	cpc	r14, r1
    1840:	f1 04       	cpc	r15, r1
    1842:	09 f4       	brne	.+2      	; 0x1846 <digital_load_event.lto_priv.90+0x44>
    1844:	ae c0       	rjmp	.+348    	; 0x19a2 <digital_load_event.lto_priv.90+0x1a0>
    1846:	6c 89       	ldd	r22, Y+20	; 0x14
    1848:	7d 89       	ldd	r23, Y+21	; 0x15
    184a:	8e 89       	ldd	r24, Y+22	; 0x16
    184c:	41 2f       	mov	r20, r17
    184e:	0e 94 d6 4e 	call	0x9dac	; 0x9dac <gpio_out_write.lto_priv.79>
    1852:	c5 01       	movw	r24, r10
    1854:	0e 94 ee 0b 	call	0x17dc	; 0x17dc <move_free.lto_priv.86>
    1858:	c1 14       	cp	r12, r1
    185a:	d1 04       	cpc	r13, r1
    185c:	e1 04       	cpc	r14, r1
    185e:	f1 04       	cpc	r15, r1
    1860:	89 f1       	breq	.+98     	; 0x18c4 <digital_load_event.lto_priv.90+0xc2>
    1862:	8b 8d       	ldd	r24, Y+27	; 0x1b
    1864:	9c 8d       	ldd	r25, Y+28	; 0x1c
    1866:	ad 8d       	ldd	r26, Y+29	; 0x1d
    1868:	be 8d       	ldd	r27, Y+30	; 0x1e
    186a:	c8 16       	cp	r12, r24
    186c:	d9 06       	cpc	r13, r25
    186e:	ea 06       	cpc	r14, r26
    1870:	fb 06       	cpc	r15, r27
    1872:	40 f5       	brcc	.+80     	; 0x18c4 <digital_load_event.lto_priv.90+0xc2>
    1874:	4f 89       	ldd	r20, Y+23	; 0x17
    1876:	58 8d       	ldd	r21, Y+24	; 0x18
    1878:	69 8d       	ldd	r22, Y+25	; 0x19
    187a:	7a 8d       	ldd	r23, Y+26	; 0x1a
    187c:	41 15       	cp	r20, r1
    187e:	51 05       	cpc	r21, r1
    1880:	61 05       	cpc	r22, r1
    1882:	71 05       	cpc	r23, r1
    1884:	09 f4       	brne	.+2      	; 0x1888 <digital_load_event.lto_priv.90+0x86>
    1886:	bb c0       	rjmp	.+374    	; 0x19fe <digital_load_event.lto_priv.90+0x1fc>
    1888:	8c 81       	ldd	r24, Y+4	; 0x04
    188a:	9d 81       	ldd	r25, Y+5	; 0x05
    188c:	ae 81       	ldd	r26, Y+6	; 0x06
    188e:	bf 81       	ldd	r27, Y+7	; 0x07
    1890:	48 0f       	add	r20, r24
    1892:	59 1f       	adc	r21, r25
    1894:	6a 1f       	adc	r22, r26
    1896:	7b 1f       	adc	r23, r27
    1898:	16 60       	ori	r17, 0x06	; 6
    189a:	eb a1       	ldd	r30, Y+35	; 0x23
    189c:	fc a1       	ldd	r31, Y+36	; 0x24
    189e:	30 97       	sbiw	r30, 0x00	; 0
    18a0:	b9 f1       	breq	.+110    	; 0x1910 <digital_load_event.lto_priv.90+0x10e>
    18a2:	82 80       	ldd	r8, Z+2	; 0x02
    18a4:	93 80       	ldd	r9, Z+3	; 0x03
    18a6:	a4 80       	ldd	r10, Z+4	; 0x04
    18a8:	b5 80       	ldd	r11, Z+5	; 0x05
    18aa:	87 2f       	mov	r24, r23
    18ac:	48 15       	cp	r20, r8
    18ae:	59 05       	cpc	r21, r9
    18b0:	6a 05       	cpc	r22, r10
    18b2:	8b 09       	sbc	r24, r11
    18b4:	87 fd       	sbrc	r24, 7
    18b6:	b2 c0       	rjmp	.+356    	; 0x1a1c <digital_load_event.lto_priv.90+0x21a>
    18b8:	8f a1       	ldd	r24, Y+39	; 0x27
    18ba:	91 2f       	mov	r25, r17
    18bc:	92 70       	andi	r25, 0x02	; 2
    18be:	b5 01       	movw	r22, r10
    18c0:	a4 01       	movw	r20, r8
    18c2:	7e c0       	rjmp	.+252    	; 0x19c0 <digital_load_event.lto_priv.90+0x1be>
    18c4:	8f a1       	ldd	r24, Y+39	; 0x27
    18c6:	21 e0       	ldi	r18, 0x01	; 1
    18c8:	c1 14       	cp	r12, r1
    18ca:	d1 04       	cpc	r13, r1
    18cc:	e1 04       	cpc	r14, r1
    18ce:	f1 04       	cpc	r15, r1
    18d0:	09 f0       	breq	.+2      	; 0x18d4 <digital_load_event.lto_priv.90+0xd2>
    18d2:	69 c0       	rjmp	.+210    	; 0x19a6 <digital_load_event.lto_priv.90+0x1a4>
    18d4:	84 fb       	bst	r24, 4
    18d6:	99 27       	eor	r25, r25
    18d8:	90 f9       	bld	r25, 0
    18da:	31 e0       	ldi	r19, 0x01	; 1
    18dc:	93 27       	eor	r25, r19
    18de:	29 17       	cp	r18, r25
    18e0:	09 f4       	brne	.+2      	; 0x18e4 <digital_load_event.lto_priv.90+0xe2>
    18e2:	42 c0       	rjmp	.+132    	; 0x1968 <digital_load_event.lto_priv.90+0x166>
    18e4:	4f 89       	ldd	r20, Y+23	; 0x17
    18e6:	58 8d       	ldd	r21, Y+24	; 0x18
    18e8:	69 8d       	ldd	r22, Y+25	; 0x19
    18ea:	7a 8d       	ldd	r23, Y+26	; 0x1a
    18ec:	41 15       	cp	r20, r1
    18ee:	51 05       	cpc	r21, r1
    18f0:	61 05       	cpc	r22, r1
    18f2:	71 05       	cpc	r23, r1
    18f4:	c9 f1       	breq	.+114    	; 0x1968 <digital_load_event.lto_priv.90+0x166>
    18f6:	8c 81       	ldd	r24, Y+4	; 0x04
    18f8:	9d 81       	ldd	r25, Y+5	; 0x05
    18fa:	ae 81       	ldd	r26, Y+6	; 0x06
    18fc:	bf 81       	ldd	r27, Y+7	; 0x07
    18fe:	48 0f       	add	r20, r24
    1900:	59 1f       	adc	r21, r25
    1902:	6a 1f       	adc	r22, r26
    1904:	7b 1f       	adc	r23, r27
    1906:	14 60       	ori	r17, 0x04	; 4
    1908:	eb a1       	ldd	r30, Y+35	; 0x23
    190a:	fc a1       	ldd	r31, Y+36	; 0x24
    190c:	30 97       	sbiw	r30, 0x00	; 0
    190e:	49 f6       	brne	.-110    	; 0x18a2 <digital_load_event.lto_priv.90+0xa0>
    1910:	2f a1       	ldd	r18, Y+39	; 0x27
    1912:	48 8b       	std	Y+16, r20	; 0x10
    1914:	59 8b       	std	Y+17, r21	; 0x11
    1916:	6a 8b       	std	Y+18, r22	; 0x12
    1918:	7b 8b       	std	Y+19, r23	; 0x13
    191a:	20 71       	andi	r18, 0x10	; 16
    191c:	21 2b       	or	r18, r17
    191e:	2f a3       	std	Y+39, r18	; 0x27
    1920:	21 2f       	mov	r18, r17
    1922:	24 70       	andi	r18, 0x04	; 4
    1924:	11 ff       	sbrs	r17, 1
    1926:	65 c0       	rjmp	.+202    	; 0x19f2 <digital_load_event.lto_priv.90+0x1f0>
    1928:	8c 0d       	add	r24, r12
    192a:	9d 1d       	adc	r25, r13
    192c:	ae 1d       	adc	r26, r14
    192e:	bf 1d       	adc	r27, r15
    1930:	21 11       	cpse	r18, r1
    1932:	58 c0       	rjmp	.+176    	; 0x19e4 <digital_load_event.lto_priv.90+0x1e2>
    1934:	21 ef       	ldi	r18, 0xF1	; 241
    1936:	3a e0       	ldi	r19, 0x0A	; 10
    1938:	3b 83       	std	Y+3, r19	; 0x03
    193a:	2a 83       	std	Y+2, r18	; 0x02
    193c:	8c 83       	std	Y+4, r24	; 0x04
    193e:	9d 83       	std	Y+5, r25	; 0x05
    1940:	ae 83       	std	Y+6, r26	; 0x06
    1942:	bf 83       	std	Y+7, r27	; 0x07
    1944:	c8 86       	std	Y+8, r12	; 0x08
    1946:	d9 86       	std	Y+9, r13	; 0x09
    1948:	ea 86       	std	Y+10, r14	; 0x0a
    194a:	fb 86       	std	Y+11, r15	; 0x0b
    194c:	8b 8d       	ldd	r24, Y+27	; 0x1b
    194e:	9c 8d       	ldd	r25, Y+28	; 0x1c
    1950:	ad 8d       	ldd	r26, Y+29	; 0x1d
    1952:	be 8d       	ldd	r27, Y+30	; 0x1e
    1954:	8c 19       	sub	r24, r12
    1956:	9d 09       	sbc	r25, r13
    1958:	ae 09       	sbc	r26, r14
    195a:	bf 09       	sbc	r27, r15
    195c:	8c 87       	std	Y+12, r24	; 0x0c
    195e:	9d 87       	std	Y+13, r25	; 0x0d
    1960:	ae 87       	std	Y+14, r26	; 0x0e
    1962:	bf 87       	std	Y+15, r27	; 0x0f
    1964:	81 e0       	ldi	r24, 0x01	; 1
    1966:	11 c0       	rjmp	.+34     	; 0x198a <digital_load_event.lto_priv.90+0x188>
    1968:	90 e0       	ldi	r25, 0x00	; 0
    196a:	eb a1       	ldd	r30, Y+35	; 0x23
    196c:	fc a1       	ldd	r31, Y+36	; 0x24
    196e:	30 97       	sbiw	r30, 0x00	; 0
    1970:	19 f5       	brne	.+70     	; 0x19b8 <digital_load_event.lto_priv.90+0x1b6>
    1972:	18 8a       	std	Y+16, r1	; 0x10
    1974:	19 8a       	std	Y+17, r1	; 0x11
    1976:	1a 8a       	std	Y+18, r1	; 0x12
    1978:	1b 8a       	std	Y+19, r1	; 0x13
    197a:	80 71       	andi	r24, 0x10	; 16
    197c:	81 2b       	or	r24, r17
    197e:	8f a3       	std	Y+39, r24	; 0x27
    1980:	21 2f       	mov	r18, r17
    1982:	24 70       	andi	r18, 0x04	; 4
    1984:	80 e0       	ldi	r24, 0x00	; 0
    1986:	91 11       	cpse	r25, r1
    1988:	3e c0       	rjmp	.+124    	; 0x1a06 <digital_load_event.lto_priv.90+0x204>
    198a:	df 91       	pop	r29
    198c:	cf 91       	pop	r28
    198e:	1f 91       	pop	r17
    1990:	ff 90       	pop	r15
    1992:	ef 90       	pop	r14
    1994:	df 90       	pop	r13
    1996:	cf 90       	pop	r12
    1998:	bf 90       	pop	r11
    199a:	af 90       	pop	r10
    199c:	9f 90       	pop	r9
    199e:	8f 90       	pop	r8
    19a0:	08 95       	ret
    19a2:	10 e0       	ldi	r17, 0x00	; 0
    19a4:	50 cf       	rjmp	.-352    	; 0x1846 <digital_load_event.lto_priv.90+0x44>
    19a6:	20 e0       	ldi	r18, 0x00	; 0
    19a8:	84 fb       	bst	r24, 4
    19aa:	99 27       	eor	r25, r25
    19ac:	90 f9       	bld	r25, 0
    19ae:	31 e0       	ldi	r19, 0x01	; 1
    19b0:	93 27       	eor	r25, r19
    19b2:	29 13       	cpse	r18, r25
    19b4:	97 cf       	rjmp	.-210    	; 0x18e4 <digital_load_event.lto_priv.90+0xe2>
    19b6:	d8 cf       	rjmp	.-80     	; 0x1968 <digital_load_event.lto_priv.90+0x166>
    19b8:	42 81       	ldd	r20, Z+2	; 0x02
    19ba:	53 81       	ldd	r21, Z+3	; 0x03
    19bc:	64 81       	ldd	r22, Z+4	; 0x04
    19be:	75 81       	ldd	r23, Z+5	; 0x05
    19c0:	48 8b       	std	Y+16, r20	; 0x10
    19c2:	59 8b       	std	Y+17, r21	; 0x11
    19c4:	6a 8b       	std	Y+18, r22	; 0x12
    19c6:	7b 8b       	std	Y+19, r23	; 0x13
    19c8:	80 71       	andi	r24, 0x10	; 16
    19ca:	14 60       	ori	r17, 0x04	; 4
    19cc:	18 2b       	or	r17, r24
    19ce:	1f a3       	std	Y+39, r17	; 0x27
    19d0:	99 23       	and	r25, r25
    19d2:	79 f0       	breq	.+30     	; 0x19f2 <digital_load_event.lto_priv.90+0x1f0>
    19d4:	8c 81       	ldd	r24, Y+4	; 0x04
    19d6:	9d 81       	ldd	r25, Y+5	; 0x05
    19d8:	ae 81       	ldd	r26, Y+6	; 0x06
    19da:	bf 81       	ldd	r27, Y+7	; 0x07
    19dc:	8c 0d       	add	r24, r12
    19de:	9d 1d       	adc	r25, r13
    19e0:	ae 1d       	adc	r26, r14
    19e2:	bf 1d       	adc	r27, r15
    19e4:	2b 2f       	mov	r18, r27
    19e6:	84 17       	cp	r24, r20
    19e8:	95 07       	cpc	r25, r21
    19ea:	a6 07       	cpc	r26, r22
    19ec:	27 0b       	sbc	r18, r23
    19ee:	27 fd       	sbrc	r18, 7
    19f0:	a1 cf       	rjmp	.-190    	; 0x1934 <digital_load_event.lto_priv.90+0x132>
    19f2:	4c 83       	std	Y+4, r20	; 0x04
    19f4:	5d 83       	std	Y+5, r21	; 0x05
    19f6:	6e 83       	std	Y+6, r22	; 0x06
    19f8:	7f 83       	std	Y+7, r23	; 0x07
    19fa:	81 e0       	ldi	r24, 0x01	; 1
    19fc:	c6 cf       	rjmp	.-116    	; 0x198a <digital_load_event.lto_priv.90+0x188>
    19fe:	12 60       	ori	r17, 0x02	; 2
    1a00:	8f a1       	ldd	r24, Y+39	; 0x27
    1a02:	92 e0       	ldi	r25, 0x02	; 2
    1a04:	b2 cf       	rjmp	.-156    	; 0x196a <digital_load_event.lto_priv.90+0x168>
    1a06:	40 e0       	ldi	r20, 0x00	; 0
    1a08:	50 e0       	ldi	r21, 0x00	; 0
    1a0a:	ba 01       	movw	r22, r20
    1a0c:	8c 81       	ldd	r24, Y+4	; 0x04
    1a0e:	9d 81       	ldd	r25, Y+5	; 0x05
    1a10:	ae 81       	ldd	r26, Y+6	; 0x06
    1a12:	bf 81       	ldd	r27, Y+7	; 0x07
    1a14:	89 cf       	rjmp	.-238    	; 0x1928 <digital_load_event.lto_priv.90+0x126>
    1a16:	8b e1       	ldi	r24, 0x1B	; 27
    1a18:	0e 94 fa 0b 	call	0x17f4	; 0x17f4 <sched_shutdown.lto_priv.12>
    1a1c:	88 e1       	ldi	r24, 0x18	; 24
    1a1e:	0e 94 fa 0b 	call	0x17f4	; 0x17f4 <sched_shutdown.lto_priv.12>
