000017fe <digital_load_event.lto_priv.90>:
    17fe:	8f 92       	push	r8
    1800:	9f 92       	push	r9
    1802:	af 92       	push	r10
    1804:	bf 92       	push	r11
    1806:	cf 92       	push	r12
    1808:	df 92       	push	r13
    180a:	ef 92       	push	r14
    180c:	ff 92       	push	r15
    180e:	1f 93       	push	r17
    1810:	cf 93       	push	r28
    1812:	df 93       	push	r29
    1814:	ec 01       	movw	r28, r24
    1816:	eb a0       	ldd	r14, Y+35	; 0x23
    1818:	fc a0       	ldd	r15, Y+36	; 0x24
    181a:	e1 14       	cp	r14, r1
    181c:	f1 04       	cpc	r15, r1
    181e:	09 f4       	brne	.+2      	; 0x1822 <digital_load_event.lto_priv.90+0x24>
    1820:	00 c1       	rjmp	.+512    	; 0x1a22 <digital_load_event.lto_priv.90+0x224>
    1822:	f7 01       	movw	r30, r14
    1824:	80 81       	ld	r24, Z
    1826:	91 81       	ldd	r25, Z+1	; 0x01
    1828:	9c a3       	std	Y+36, r25	; 0x24
    182a:	8b a3       	std	Y+35, r24	; 0x23
    182c:	86 80       	ldd	r8, Z+6	; 0x06
    182e:	97 80       	ldd	r9, Z+7	; 0x07
    1830:	a0 84       	ldd	r10, Z+8	; 0x08
    1832:	b1 84       	ldd	r11, Z+9	; 0x09
    1834:	11 e0       	ldi	r17, 0x01	; 1
    1836:	81 14       	cp	r8, r1
    1838:	91 04       	cpc	r9, r1
    183a:	a1 04       	cpc	r10, r1
    183c:	b1 04       	cpc	r11, r1
    183e:	09 f4       	brne	.+2      	; 0x1842 <digital_load_event.lto_priv.90+0x44>
    1840:	b6 c0       	rjmp	.+364    	; 0x19ae <digital_load_event.lto_priv.90+0x1b0>
    1842:	6c 89       	ldd	r22, Y+20	; 0x14
    1844:	7d 89       	ldd	r23, Y+21	; 0x15
    1846:	8e 89       	ldd	r24, Y+22	; 0x16
    1848:	41 2f       	mov	r20, r17
    184a:	0e 94 18 4f 	call	0x9e30	; 0x9e30 <gpio_out_write.lto_priv.79>
    184e:	80 91 6d 01 	lds	r24, 0x016D	; 0x80016d <move_free_list.lto_priv.87>
    1852:	90 91 6e 01 	lds	r25, 0x016E	; 0x80016e <move_free_list.lto_priv.87+0x1>
    1856:	f7 01       	movw	r30, r14
    1858:	91 83       	std	Z+1, r25	; 0x01
    185a:	80 83       	st	Z, r24
    185c:	f0 92 6e 01 	sts	0x016E, r15	; 0x80016e <move_free_list.lto_priv.87+0x1>
    1860:	e0 92 6d 01 	sts	0x016D, r14	; 0x80016d <move_free_list.lto_priv.87>
    1864:	81 14       	cp	r8, r1
    1866:	91 04       	cpc	r9, r1
    1868:	a1 04       	cpc	r10, r1
    186a:	b1 04       	cpc	r11, r1
    186c:	89 f1       	breq	.+98     	; 0x18d0 <digital_load_event.lto_priv.90+0xd2>
    186e:	8b 8d       	ldd	r24, Y+27	; 0x1b
    1870:	9c 8d       	ldd	r25, Y+28	; 0x1c
    1872:	ad 8d       	ldd	r26, Y+29	; 0x1d
    1874:	be 8d       	ldd	r27, Y+30	; 0x1e
    1876:	88 16       	cp	r8, r24
    1878:	99 06       	cpc	r9, r25
    187a:	aa 06       	cpc	r10, r26
    187c:	bb 06       	cpc	r11, r27
    187e:	40 f5       	brcc	.+80     	; 0x18d0 <digital_load_event.lto_priv.90+0xd2>
    1880:	4f 89       	ldd	r20, Y+23	; 0x17
    1882:	58 8d       	ldd	r21, Y+24	; 0x18
    1884:	69 8d       	ldd	r22, Y+25	; 0x19
    1886:	7a 8d       	ldd	r23, Y+26	; 0x1a
    1888:	41 15       	cp	r20, r1
    188a:	51 05       	cpc	r21, r1
    188c:	61 05       	cpc	r22, r1
    188e:	71 05       	cpc	r23, r1
    1890:	09 f4       	brne	.+2      	; 0x1894 <digital_load_event.lto_priv.90+0x96>
    1892:	bb c0       	rjmp	.+374    	; 0x1a0a <digital_load_event.lto_priv.90+0x20c>
    1894:	8c 81       	ldd	r24, Y+4	; 0x04
    1896:	9d 81       	ldd	r25, Y+5	; 0x05
    1898:	ae 81       	ldd	r26, Y+6	; 0x06
    189a:	bf 81       	ldd	r27, Y+7	; 0x07
    189c:	48 0f       	add	r20, r24
    189e:	59 1f       	adc	r21, r25
    18a0:	6a 1f       	adc	r22, r26
    18a2:	7b 1f       	adc	r23, r27
    18a4:	16 60       	ori	r17, 0x06	; 6
    18a6:	eb a1       	ldd	r30, Y+35	; 0x23
    18a8:	fc a1       	ldd	r31, Y+36	; 0x24
    18aa:	30 97       	sbiw	r30, 0x00	; 0
    18ac:	b9 f1       	breq	.+110    	; 0x191c <digital_load_event.lto_priv.90+0x11e>
    18ae:	c2 80       	ldd	r12, Z+2	; 0x02
    18b0:	d3 80       	ldd	r13, Z+3	; 0x03
    18b2:	e4 80       	ldd	r14, Z+4	; 0x04
    18b4:	f5 80       	ldd	r15, Z+5	; 0x05
    18b6:	87 2f       	mov	r24, r23
    18b8:	4c 15       	cp	r20, r12
    18ba:	5d 05       	cpc	r21, r13
    18bc:	6e 05       	cpc	r22, r14
    18be:	8f 09       	sbc	r24, r15
    18c0:	87 fd       	sbrc	r24, 7
    18c2:	b2 c0       	rjmp	.+356    	; 0x1a28 <digital_load_event.lto_priv.90+0x22a>
    18c4:	8f a1       	ldd	r24, Y+39	; 0x27
    18c6:	91 2f       	mov	r25, r17
    18c8:	92 70       	andi	r25, 0x02	; 2
    18ca:	b7 01       	movw	r22, r14
    18cc:	a6 01       	movw	r20, r12
    18ce:	7e c0       	rjmp	.+252    	; 0x19cc <digital_load_event.lto_priv.90+0x1ce>
    18d0:	8f a1       	ldd	r24, Y+39	; 0x27
    18d2:	21 e0       	ldi	r18, 0x01	; 1
    18d4:	81 14       	cp	r8, r1
    18d6:	91 04       	cpc	r9, r1
    18d8:	a1 04       	cpc	r10, r1
    18da:	b1 04       	cpc	r11, r1
    18dc:	09 f0       	breq	.+2      	; 0x18e0 <digital_load_event.lto_priv.90+0xe2>
    18de:	69 c0       	rjmp	.+210    	; 0x19b2 <digital_load_event.lto_priv.90+0x1b4>
    18e0:	84 fb       	bst	r24, 4
    18e2:	99 27       	eor	r25, r25
    18e4:	90 f9       	bld	r25, 0
    18e6:	31 e0       	ldi	r19, 0x01	; 1
    18e8:	93 27       	eor	r25, r19
    18ea:	29 17       	cp	r18, r25
    18ec:	09 f4       	brne	.+2      	; 0x18f0 <digital_load_event.lto_priv.90+0xf2>
    18ee:	42 c0       	rjmp	.+132    	; 0x1974 <digital_load_event.lto_priv.90+0x176>
    18f0:	4f 89       	ldd	r20, Y+23	; 0x17
    18f2:	58 8d       	ldd	r21, Y+24	; 0x18
    18f4:	69 8d       	ldd	r22, Y+25	; 0x19
    18f6:	7a 8d       	ldd	r23, Y+26	; 0x1a
    18f8:	41 15       	cp	r20, r1
    18fa:	51 05       	cpc	r21, r1
    18fc:	61 05       	cpc	r22, r1
    18fe:	71 05       	cpc	r23, r1
    1900:	c9 f1       	breq	.+114    	; 0x1974 <digital_load_event.lto_priv.90+0x176>
    1902:	8c 81       	ldd	r24, Y+4	; 0x04
    1904:	9d 81       	ldd	r25, Y+5	; 0x05
    1906:	ae 81       	ldd	r26, Y+6	; 0x06
    1908:	bf 81       	ldd	r27, Y+7	; 0x07
    190a:	48 0f       	add	r20, r24
    190c:	59 1f       	adc	r21, r25
    190e:	6a 1f       	adc	r22, r26
    1910:	7b 1f       	adc	r23, r27
    1912:	14 60       	ori	r17, 0x04	; 4
    1914:	eb a1       	ldd	r30, Y+35	; 0x23
    1916:	fc a1       	ldd	r31, Y+36	; 0x24
    1918:	30 97       	sbiw	r30, 0x00	; 0
    191a:	49 f6       	brne	.-110    	; 0x18ae <digital_load_event.lto_priv.90+0xb0>
    191c:	2f a1       	ldd	r18, Y+39	; 0x27
    191e:	48 8b       	std	Y+16, r20	; 0x10
    1920:	59 8b       	std	Y+17, r21	; 0x11
    1922:	6a 8b       	std	Y+18, r22	; 0x12
    1924:	7b 8b       	std	Y+19, r23	; 0x13
    1926:	20 71       	andi	r18, 0x10	; 16
    1928:	21 2b       	or	r18, r17
    192a:	2f a3       	std	Y+39, r18	; 0x27
    192c:	21 2f       	mov	r18, r17
    192e:	24 70       	andi	r18, 0x04	; 4
    1930:	11 ff       	sbrs	r17, 1
    1932:	65 c0       	rjmp	.+202    	; 0x19fe <digital_load_event.lto_priv.90+0x200>
    1934:	88 0d       	add	r24, r8
    1936:	99 1d       	adc	r25, r9
    1938:	aa 1d       	adc	r26, r10
    193a:	bb 1d       	adc	r27, r11
    193c:	21 11       	cpse	r18, r1
    193e:	58 c0       	rjmp	.+176    	; 0x19f0 <digital_load_event.lto_priv.90+0x1f2>
    1940:	2b ef       	ldi	r18, 0xFB	; 251
    1942:	3a e0       	ldi	r19, 0x0A	; 10
    1944:	3b 83       	std	Y+3, r19	; 0x03
    1946:	2a 83       	std	Y+2, r18	; 0x02
    1948:	8c 83       	std	Y+4, r24	; 0x04
    194a:	9d 83       	std	Y+5, r25	; 0x05
    194c:	ae 83       	std	Y+6, r26	; 0x06
    194e:	bf 83       	std	Y+7, r27	; 0x07
    1950:	88 86       	std	Y+8, r8	; 0x08
    1952:	99 86       	std	Y+9, r9	; 0x09
    1954:	aa 86       	std	Y+10, r10	; 0x0a
    1956:	bb 86       	std	Y+11, r11	; 0x0b
    1958:	8b 8d       	ldd	r24, Y+27	; 0x1b
    195a:	9c 8d       	ldd	r25, Y+28	; 0x1c
    195c:	ad 8d       	ldd	r26, Y+29	; 0x1d
    195e:	be 8d       	ldd	r27, Y+30	; 0x1e
    1960:	88 19       	sub	r24, r8
    1962:	99 09       	sbc	r25, r9
    1964:	aa 09       	sbc	r26, r10
    1966:	bb 09       	sbc	r27, r11
    1968:	8c 87       	std	Y+12, r24	; 0x0c
    196a:	9d 87       	std	Y+13, r25	; 0x0d
    196c:	ae 87       	std	Y+14, r26	; 0x0e
    196e:	bf 87       	std	Y+15, r27	; 0x0f
    1970:	81 e0       	ldi	r24, 0x01	; 1
    1972:	11 c0       	rjmp	.+34     	; 0x1996 <digital_load_event.lto_priv.90+0x198>
    1974:	90 e0       	ldi	r25, 0x00	; 0
    1976:	eb a1       	ldd	r30, Y+35	; 0x23
    1978:	fc a1       	ldd	r31, Y+36	; 0x24
    197a:	30 97       	sbiw	r30, 0x00	; 0
    197c:	19 f5       	brne	.+70     	; 0x19c4 <digital_load_event.lto_priv.90+0x1c6>
    197e:	18 8a       	std	Y+16, r1	; 0x10
    1980:	19 8a       	std	Y+17, r1	; 0x11
    1982:	1a 8a       	std	Y+18, r1	; 0x12
    1984:	1b 8a       	std	Y+19, r1	; 0x13
    1986:	80 71       	andi	r24, 0x10	; 16
    1988:	81 2b       	or	r24, r17
    198a:	8f a3       	std	Y+39, r24	; 0x27
    198c:	21 2f       	mov	r18, r17
    198e:	24 70       	andi	r18, 0x04	; 4
    1990:	80 e0       	ldi	r24, 0x00	; 0
    1992:	91 11       	cpse	r25, r1
    1994:	3e c0       	rjmp	.+124    	; 0x1a12 <digital_load_event.lto_priv.90+0x214>
    1996:	df 91       	pop	r29
    1998:	cf 91       	pop	r28
    199a:	1f 91       	pop	r17
    199c:	ff 90       	pop	r15
    199e:	ef 90       	pop	r14
    19a0:	df 90       	pop	r13
    19a2:	cf 90       	pop	r12
    19a4:	bf 90       	pop	r11
    19a6:	af 90       	pop	r10
    19a8:	9f 90       	pop	r9
    19aa:	8f 90       	pop	r8
    19ac:	08 95       	ret
    19ae:	10 e0       	ldi	r17, 0x00	; 0
    19b0:	48 cf       	rjmp	.-368    	; 0x1842 <digital_load_event.lto_priv.90+0x44>
    19b2:	20 e0       	ldi	r18, 0x00	; 0
    19b4:	84 fb       	bst	r24, 4
    19b6:	99 27       	eor	r25, r25
    19b8:	90 f9       	bld	r25, 0
    19ba:	31 e0       	ldi	r19, 0x01	; 1
    19bc:	93 27       	eor	r25, r19
    19be:	29 13       	cpse	r18, r25
    19c0:	97 cf       	rjmp	.-210    	; 0x18f0 <digital_load_event.lto_priv.90+0xf2>
    19c2:	d8 cf       	rjmp	.-80     	; 0x1974 <digital_load_event.lto_priv.90+0x176>
    19c4:	42 81       	ldd	r20, Z+2	; 0x02
    19c6:	53 81       	ldd	r21, Z+3	; 0x03
    19c8:	64 81       	ldd	r22, Z+4	; 0x04
    19ca:	75 81       	ldd	r23, Z+5	; 0x05
    19cc:	48 8b       	std	Y+16, r20	; 0x10
    19ce:	59 8b       	std	Y+17, r21	; 0x11
    19d0:	6a 8b       	std	Y+18, r22	; 0x12
    19d2:	7b 8b       	std	Y+19, r23	; 0x13
    19d4:	80 71       	andi	r24, 0x10	; 16
    19d6:	14 60       	ori	r17, 0x04	; 4
    19d8:	18 2b       	or	r17, r24
    19da:	1f a3       	std	Y+39, r17	; 0x27
    19dc:	99 23       	and	r25, r25
    19de:	79 f0       	breq	.+30     	; 0x19fe <digital_load_event.lto_priv.90+0x200>
    19e0:	8c 81       	ldd	r24, Y+4	; 0x04
    19e2:	9d 81       	ldd	r25, Y+5	; 0x05
    19e4:	ae 81       	ldd	r26, Y+6	; 0x06
    19e6:	bf 81       	ldd	r27, Y+7	; 0x07
    19e8:	88 0d       	add	r24, r8
    19ea:	99 1d       	adc	r25, r9
    19ec:	aa 1d       	adc	r26, r10
    19ee:	bb 1d       	adc	r27, r11
    19f0:	2b 2f       	mov	r18, r27
    19f2:	84 17       	cp	r24, r20
    19f4:	95 07       	cpc	r25, r21
    19f6:	a6 07       	cpc	r26, r22
    19f8:	27 0b       	sbc	r18, r23
    19fa:	27 fd       	sbrc	r18, 7
    19fc:	a1 cf       	rjmp	.-190    	; 0x1940 <digital_load_event.lto_priv.90+0x142>
    19fe:	4c 83       	std	Y+4, r20	; 0x04
    1a00:	5d 83       	std	Y+5, r21	; 0x05
    1a02:	6e 83       	std	Y+6, r22	; 0x06
    1a04:	7f 83       	std	Y+7, r23	; 0x07
    1a06:	81 e0       	ldi	r24, 0x01	; 1
    1a08:	c6 cf       	rjmp	.-116    	; 0x1996 <digital_load_event.lto_priv.90+0x198>
    1a0a:	12 60       	ori	r17, 0x02	; 2
    1a0c:	8f a1       	ldd	r24, Y+39	; 0x27
    1a0e:	92 e0       	ldi	r25, 0x02	; 2
    1a10:	b2 cf       	rjmp	.-156    	; 0x1976 <digital_load_event.lto_priv.90+0x178>
    1a12:	40 e0       	ldi	r20, 0x00	; 0
    1a14:	50 e0       	ldi	r21, 0x00	; 0
    1a16:	ba 01       	movw	r22, r20
    1a18:	8c 81       	ldd	r24, Y+4	; 0x04
    1a1a:	9d 81       	ldd	r25, Y+5	; 0x05
    1a1c:	ae 81       	ldd	r26, Y+6	; 0x06
    1a1e:	bf 81       	ldd	r27, Y+7	; 0x07
    1a20:	89 cf       	rjmp	.-238    	; 0x1934 <digital_load_event.lto_priv.90+0x136>
    1a22:	8b e1       	ldi	r24, 0x1B	; 27
    1a24:	0e 94 f8 0b 	call	0x17f0	; 0x17f0 <sched_shutdown.lto_priv.12>
    1a28:	88 e1       	ldi	r24, 0x18	; 24
    1a2a:	0e 94 f8 0b 	call	0x17f0	; 0x17f0 <sched_shutdown.lto_priv.12>
