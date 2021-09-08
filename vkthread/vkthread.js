/**
* ng-vkThread is angular plugin to execute javascript function(s) in a thread.
*
* https://github.com/vkiryukhin/ng-vkthread
* http://www.eslinstructor.net/ng-vkthread/demo/
*
* @version: 2.5.0
* The MIT License (MIT)
*
* @author: Vadim Kiryukhin ( vkiryukhin @ gmail.com )
*
* Copyright (c) 2016 Vadim Kiryukhin
*
* From Brian, Your request to use ng-vkthread under the MIT license for distribution purposes is approved.
*/

/* jshint maxlen:false */

(function (angular) {
 'use strict';
    /**
     * This is a fragment of JSONfn plugin ( https://github.com/vkiryukhin/jsonfn )
     * JSONfn extends JSON.stringify() functionality and makes possible to stringify
     * objects with functions and regexp.
     */
 	var JSONfn = {
	    stringify:function (obj) {
	      return JSON.stringify(obj, function (key, value) {
	        var fnBody;
	      if (value instanceof Function || typeof value === 'function') {

	        fnBody = value.toString();

	        if (fnBody.length < 8 || fnBody.substring(0, 8) !== 'function') { //this is ES6 Arrow Function
	          return '_NuFrRa_' + fnBody;
	        }
	        return fnBody;
	      }
	      if (value instanceof RegExp) {
	        return '_PxEgEr_' + value;
	      }
	      return value;
	      });
	    }
	  };

    var workerJs = '(function(){var JSONfn={parse:function(str,date2obj){var iso8061=date2obj?/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/:false;return JSON.parse(str,function(key,value){var prefix,func,fnArgs,fnBody;if(typeof value!=="string")return value;if(value.length<8)return value;prefix=value.substring(0,8);if(iso8061&&value.match(iso8061))return new Date(value);if(prefix==="function")return eval("("+value+")");if(prefix==="_PxEgEr_")return eval(value.slice(8));if(prefix==="_NuFrRa_"){func=value.slice(8).trim().split("=>");fnArgs=func[0].trim();fnBody=func[1].trim();if(fnArgs.indexOf("(")<0)fnArgs="("+fnArgs+")";if(fnBody.indexOf("{")<0)fnBody="{ return "+fnBody+"}";return eval("("+"function"+fnArgs+fnBody+")")}return value})}};onmessage=function(e){var obj=JSONfn.parse(e.data,true),cntx=obj.context||self;if(obj.importFiles)importScripts.apply(null,obj.importFiles);if(typeof obj.fn==="function")if(typeof Promise!=="undefined")Promise.resolve(obj.fn.apply(cntx,obj.args)).then(function(data){postMessage(data)})["catch"](function(reason){postMessage(reason)});else postMessage(obj.fn.apply(cntx,obj.args));else postMessage(self[obj.fn].apply(cntx,obj.args))};function vkhttp(cfg){var body=cfg.body?JSON.stringify(cfg.body):null,contentType=cfg.contentType||"application/json",method=cfg.method?cfg.method.toUpperCase():"GET",xhr=new XMLHttpRequest,ret;xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)ret=xhr.responseText;else ret="Error: "+xhr.status+xhr.statusText};xhr.onerror=function(data){ret=xhr.status+xhr.statusText};xhr.open(method,cfg.url,false);if(method==="POST")xhr.setRequestHeader("Content-Type",contentType);xhr.send(body);return ret}})();';
    var workerBlob = new Blob([workerJs], {type: 'application/javascript'});
    /**
     * Angular Provider function
     */
    var VkthreadProvider = function(){

        this.$get = ['$q', '$timeout', '$log', function($q, $timeout, $log) {
                // This is the default number of simultaneous workers
                // that we will have at any given time
            var DEFAULT_NUM_MAX_THREADS = 2,
                // This is the maximum number of simultaneous workers
                // even if the user machine has more cores.
                NUM_MAX_THREADS = 8,
                // List of workers (busy and available)
                workerPool = [],
                // List of pending tasks
                taskQueue = [],
                // Number of effective maximum workers
                numMaxActiveWorkers;

            var VkThread = function(){
                this.version = '2.5.0';
                this.getVersion = function(){
                    return this.version;
                };
            };

            /**
             * @private
             * @function initializeNumMaxActiveWorkers
             *
             * @description Initialize the maximum  number of workers to have
             * at any given time. We do not want to arbitrarily create a large
             * number of workers since that leads to a crash.
             *
             * Further, a large number of workers results in a significant overhead,
             * so we will limit it to a certain maximum value in all cases.
             */
            function initializeNumMaxActiveWorkers() {
              // Get the number logical processors from the call below.
              numMaxActiveWorkers = getNumLogicalProcessors();
              if (!numMaxActiveWorkers) {
                // The call above is not supported on certain browsers (safari for instance).
                // What we do in that instance is to just assume a certain number of max allowed
                // workders.
                numMaxActiveWorkers = DEFAULT_NUM_MAX_THREADS;
              }

              // Limit the number of workers at any time to NUM_MAX_WORKERS.
              numMaxActiveWorkers = Math.min(numMaxActiveWorkers, NUM_MAX_THREADS);
            }

            /**
             * @function getNumLogicalProcessors
             *
             * @description Get the number of logical processors available to
             * run threads on the user's computer. Note that this property is
             * not supported on all browsers, so this value may be undefined on
             * some browsers.
             *
             * @see
             * https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency
             *
             * @returns {Number}
             */
            function getNumLogicalProcessors() {
              return navigator.hardwareConcurrency;
            }

            /**
             * @private
             * @function enqueueTask
             *
             * @description Enqueue the task, now it is in the pending queue
             *
             * @param {Object} param - Contains the function to execute in the web worker.
             *
             * @param {Object} deferred - The deferred to resolve or reject once the worker
             * is done with the processing.
             *
             */
            function enqueueTask(param, deferred) {
              taskQueue.push({
                param: param,
                deferred: deferred
              });
            }

            /**
             * @private
             * @function dequeueTask
             *
             * @description Dequeue the task at the first position, if any
             *
             * @return {Object} An object contains param, deferred if there is at least one
             * entry in the array. Otherwise the value returned is undefined
             */
            function dequeueTask() {
              // If the array below is empty, this function returns undefined.
              return taskQueue.shift();
            }

            /**
             * @private
             * @function performNextTaskIfWorkerAvailable
             *
             * @description Perform the next task if there is a task pending and there is a
             * worker available.
             *
             */
            function performNextTaskIfWorkerAvailable() {
              var availableWorker = getAvailableWorker();

              if (!availableWorker) {
                // There is no available worker, exit for now. Once a worker
                // completes, it will pick up the next task from the task queue.
                return;
              }

              // Dequeue task, if any
              var taskInfo = dequeueTask();

              if (!taskInfo) {
                // There is no pending task, so there is nothing to do.
                return;
              }

              // This will make the call to run the function in the web worker.
              execTaskCore(availableWorker, taskInfo);
            }

            /**
             * @private
             * @function createWorker
             *
             * @description Create and return a web worker
             *
             * @return {Object} the worker that was created
             */
            function createWorker() {
              var worker = new Worker(window.URL.createObjectURL(workerBlob));
              return worker;
            }

            /**
             * @private
             * @function getAvailableWorker
             *
             * @description Get an available worker, if any. This function will
             * create a worker if the limit is not yet reached.
             *
             * @return {Object} Contains worker and isAvailable fields
             *
             */
            function getAvailableWorker() {
              var availableWorker;

              // Determine if there is any worker that has isAvailable set to true
              var availableWorkers = workerPool.filter(function(workerInfo) {
                return workerInfo.isAvailable
              });

              if (availableWorkers.length) {
                // Available worker found, we can use that worker for the next task
                availableWorker = availableWorkers[0];
              } else if (workerPool.length < numMaxActiveWorkers) {
                // There is no available worker, but can still create a new worker since the
                // limit is not yet reached.
                availableWorker = {
                  worker: createWorker(),
                  // Currently the worker is available to process work
                  isAvailable: true
                };

                // Add the worker to the worker poll
                workerPool.push(availableWorker);
              }

              return availableWorker;
            }

            /**
             * @function exec
             *
             * @description Enqueue the task, now it is in the pending queue
             *
             * @param {Object} param - Contains the function to execute in the web worker.
             *
             */
            VkThread.prototype.exec = function(param){
              var deferred = $q.defer();

              // Enqueue the task
              enqueueTask(param, deferred);

              // Execute the task if there is a worker available
              performNextTaskIfWorkerAvailable();

              // Return the promise
              return deferred.promise;
            }

            /**
             * @private
             * @function execTaskCore
             *
             * @description Execute the task on the web worker
             *
             * @param {Object} workerInfo - Contains the available worker
             *
             * @param {Object} taskInfo - Contains the param and deferred
             *
             * @return {Promise} Resolves to the data as computed after the execution
             * of the function specified.
             *
             */
            function execTaskCore(workerInfo, taskInfo){
                var worker = workerInfo.worker,
                    param = taskInfo.param,
                    dfr = taskInfo.deferred,
                    workerTimer;

                worker.onmessage = function (oEvent) {
                  // Use the data as per the result of the function that was executed
                  handleWorkerCompletion(workerInfo, workerTimer, dfr, oEvent.data);
                };

                worker.onerror = function(error) {
                  // Use the value as provided for the error case
                  handleWorkerCompletion(workerInfo, workerTimer, dfr, param.returnValueToUseUponError);
                };

                if (param.maxExecutionDuration && (param.maxExecutionDuration > 0)) {
                  // If a maximum execution duration was provided, start a timer
                  workerTimer = $timeout(function(){
                    // This implies that the function execution has taken more than the specified
                    // duration. So what we will do is that terminate the worker and return an
                    // error. This prevents us from cases where the execution takes a long time
                    // such as a regex leading to a very long execution time.
                    // Use the value as provided for the timeout case
                    workerTimer = null;
                    handleWorkerCompletion(workerInfo, workerTimer, dfr, param.returnValueToUseUponTimeout);
                  }, param.maxExecutionDuration, false);
                }

                // Mark that the worker is no longer available since it is busy processing
                // a task.
                workerInfo.isAvailable = false;

                worker.postMessage(JSONfn.stringify(param));
                return dfr.promise;
            };

            // This function is called when the worker completes (success or failure)
            // For simplicity, we will always resolve the promise
            function handleWorkerCompletion(workerInfo, workerTimer, dfr, data){
              dfr.resolve(data);

              // Clear the timer
              clearTimer(workerTimer);
              if (workerInfo) {
                // The worker is done with the task, indicate that the worker is
                // now available for another task.
                workerInfo.isAvailable = true;
              }

              // Attempt to execute the next task, if any.
              performNextTaskIfWorkerAvailable();
            }

            function clearTimer(workerTimer) {
              if (workerTimer) {
                $timeout.cancel(workerTimer);
              }
            }

          /**
           *   Execute multiple functions, each in a separate threads.
           *
           *    @args  -- array of @param objects (described above);
           *
           *    NOTE: We are not using this function and we have not tested
           *    this function.
           */
            VkThread.prototype.execAll = function(args, cb){

                var promises = [];

                for(var ix=0; ix<args.length; ix++){
                  promises.push( this.exec(args[ix]));
                }

                return $q.all(promises).then(
                  function(values){
                    return values;
                  }
                );
            };

            // Initialize the maximum number of threads that we can create
            initializeNumMaxActiveWorkers();

            var vkThread = function() {
               return new VkThread();
            };

         return vkThread;
      }];
  };
  angular.module('ng-vkThread', [])
         .provider('vkThread', VkthreadProvider);
})( angular );
