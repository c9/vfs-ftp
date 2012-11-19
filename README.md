# VFS adapter for FTP [![Build Status](https://secure.travis-ci.org/c9/vfs-ftp.png?branch=master)](https://travis-ci.org/c9/vfs-ftp)

This module is an adapter for FTP to be used with the Virtual File System (VFS).
It provides the necessary functionality to completely abstract the FTP protocol in
order to be used directly from VFS. This will be the only way to use FTP inside
Cloud9 IDE in a near future.

Using FTP through VFS has some advantages. Besides the filesystem abstraction, the
most notable one is that it will be faster than using jsFTP (the underlying FTP engine)
in the traditional way, since VFS-ftp is piping streams whenever possible, which
makes for a faster upload/download times and a smaller memory footprint. In jsftp,
the user can choose between both options, but the piping requires more boilerplate,
whereas using buffers hrough the API is very straight-forward.

This project is work in process.